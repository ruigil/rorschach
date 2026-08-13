import type { ActorDef, ActorRef, ActorContext } from '../../system/index.ts'
import { onLifecycle, onMessage, persistencePluginAdapter } from '../../system/index.ts'
import type { SCRInvokeMsg, SCRReply } from '../../types/scr.ts'
import type { MessageRequest } from '../../system/context/request.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../../types/persistence.ts'
import { invokeSCR } from '../../system/scr/invoker.ts'

export type OperatorRunnerMsg =
  | { type: 'start' }
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }
  | { type: '_stepReply'; reply: SCRReply }
  | { type: '_parallelReply'; index: number; reply: SCRReply }
  | { type: '_conditionReply'; reply: SCRReply }
  | { type: '_jobCompleted'; jobId: string; reply: any }

export type OperatorRunnerState = {
  runId: string
  urn: string
  input: any
  replyTo: ActorRef<SCRReply>
  spawnerRef: ActorRef<any>
  originalRequest: MessageRequest
  persistenceRef: ActorRef<any> | null

  // Execution state
  phase: 'idle' | 'running' | 'completed' | 'failed'
  
  // Sequence & Fallback & Map-sequential
  operandsToRun: Array<{ urn: string; input: unknown }>
  results: Array<unknown>
  currentIndex: number

  // Parallel & Map-parallel
  pendingJobs: Record<string, { operandIndex: number; jobId: string }>
  activeCount: number

  // Retry
  retryUrn: string
  retryInput: unknown
  maxAttempts: number
  attempts: number
  backoffMs: number

  // Branch
  branchPhase: 'condition' | 'target'
  branchBranches: Record<string, { urn: string; input?: unknown }>
  branchDefault?: string
}

export const SCROperatorRunner = (opts: {
  runId: string
  urn: string
  input: any
  replyTo: ActorRef<SCRReply>
  spawnerRef: ActorRef<any>
  request: MessageRequest
}): ActorDef<any, OperatorRunnerState> => {
  const { runId, urn, input, replyTo, spawnerRef, request } = opts

  const cleanup = (state: OperatorRunnerState) => {
    if (state.persistenceRef) {
      state.persistenceRef.send({
        type: 'kv.delete',
        key: `scr.run.${state.runId}`,
      })
    }
  }

  const handlePending = (state: OperatorRunnerState, jobId: string, placeholderText: string | undefined, ctx: ActorContext<any>) => {
    state.spawnerRef.send({
      type: 'registerJob',
      jobId,
      runId: state.runId,
      urn: state.urn,
    })

    if (state.replyTo) {
      state.replyTo.send({
        type: 'pending',
        jobId,
        placeholderText: placeholderText || `Operator run is waiting for job completion: ${jobId}`,
      })
    }
    ctx.stop(ctx.self)
  }

  // Executes the next sequential step
  const executeNextStep = (state: OperatorRunnerState, ctx: ActorContext<any>) => {
    if (state.currentIndex >= state.operandsToRun.length) {
      // Completed sequence successfully
      if (state.replyTo) {
        state.replyTo.send({
          type: 'result',
          output: { results: state.results, lastResult: state.results[state.results.length - 1] },
        })
      }
      cleanup(state)
      ctx.stop(ctx.self)
      return
    }

    const op = state.operandsToRun[state.currentIndex]!
    // If operand input is not provided, feed it the previous step's output (or initial input if first)
    const inputToUse = op.input !== undefined 
      ? op.input 
      : (state.currentIndex > 0 ? state.results[state.currentIndex - 1] : state.input)

    ctx.pipeToSelf(
      invokeSCR(op.urn, inputToUse),
      (reply) => ({ type: '_stepReply' as const, reply }),
      (err) => ({ type: '_stepReply' as const, reply: { type: 'error', error: String(err) } })
    )
  }

  // Executes next fallback step
  const executeNextFallback = (state: OperatorRunnerState, ctx: ActorContext<any>) => {
    if (state.currentIndex >= state.operandsToRun.length) {
      if (state.replyTo) {
        state.replyTo.send({
          type: 'error',
          error: `All fallback operands failed. Last error: ${state.results[state.results.length - 1] || 'Unknown error'}`,
        })
      }
      cleanup(state)
      ctx.stop(ctx.self)
      return
    }

    const op = state.operandsToRun[state.currentIndex]!
    ctx.pipeToSelf(
      invokeSCR(op.urn, op.input !== undefined ? op.input : state.input),
      (reply) => ({ type: '_stepReply' as const, reply }),
      (err) => ({ type: '_stepReply' as const, reply: { type: 'error', error: String(err) } })
    )
  }

  // Executes retry turn
  const executeRetryTurn = (state: OperatorRunnerState, ctx: ActorContext<any>) => {
    const runRetry = async () => {
      if (state.backoffMs > 0 && state.attempts > 1) {
        await Bun.sleep(state.backoffMs)
      }
      return invokeSCR(state.retryUrn, state.retryInput)
    }

    ctx.pipeToSelf(
      runRetry(),
      (reply) => ({ type: '_stepReply' as const, reply }),
      (err) => ({ type: '_stepReply' as const, reply: { type: 'error', error: String(err) } })
    )
  }

  return {
    initialState: () => ({
      runId,
      urn,
      input,
      replyTo,
      spawnerRef,
      originalRequest: request,
      persistenceRef: null,

      phase: 'idle',
      operandsToRun: [],
      results: [],
      currentIndex: 0,

      pendingJobs: {},
      activeCount: 0,

      retryUrn: '',
      retryInput: null,
      maxAttempts: 1,
      attempts: 0,
      backoffMs: 0,

      branchPhase: 'condition',
      branchBranches: {},
    }),

    persistence: persistencePluginAdapter<any>(`scr.run.${runId}`),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(PersistenceProviderTopic, (event) => ({
          type: '_persistenceRef' as const,
          ref: event.ref,
        }))

        if (state.phase === 'idle') {
          ctx.send(ctx.self, { type: 'start' }, state.originalRequest)
        }
        return { state }
      },
    }),

    handler: onMessage({
      start: (state, msg, ctx) => {
        if (!state.persistenceRef) {
          return { state, stash: true }
        }

        state.phase = 'running'

        if (state.urn === 'scr:operator:workflows.sequence') {
          state.operandsToRun = state.input.operands || []
          state.results = []
          state.currentIndex = 0
          executeNextStep(state, ctx)
        } else if (state.urn === 'scr:operator:workflows.fallback') {
          state.operandsToRun = state.input.operands || []
          state.results = []
          state.currentIndex = 0
          executeNextFallback(state, ctx)
        } else if (state.urn === 'scr:operator:workflows.parallel') {
          const ops = state.input.operands || []
          state.operandsToRun = ops
          state.results = new Array(ops.length)
          state.activeCount = ops.length

          if (ops.length === 0) {
            if (state.replyTo) {
              state.replyTo.send({ type: 'result', output: { results: [] } })
            }
            cleanup(state)
            ctx.stop(ctx.self)
            return { state }
          }

          ops.forEach((op: any, idx: number) => {
            ctx.pipeToSelf(
              invokeSCR(op.urn, op.input !== undefined ? op.input : state.input),
              (reply) => ({ type: '_parallelReply' as const, index: idx, reply }),
              (err) => ({ type: '_parallelReply' as const, index: idx, reply: { type: 'error' as const, error: String(err) } })
            )
          })
        } else if (state.urn === 'scr:operator:workflows.map') {
          const items = state.input.items || []
          const childUrn = state.input.urn
          const isSeq = state.input.concurrency === 'sequence'

          state.operandsToRun = items.map((item: any) => ({ urn: childUrn, input: item }))
          state.results = isSeq ? [] : new Array(items.length)
          state.currentIndex = 0
          state.activeCount = items.length

          if (items.length === 0) {
            if (state.replyTo) {
              state.replyTo.send({ type: 'result', output: { results: [] } })
            }
            cleanup(state)
            ctx.stop(ctx.self)
            return { state }
          }

          if (isSeq) {
            executeNextStep(state, ctx)
          } else {
            state.operandsToRun.forEach((op: any, idx: number) => {
              ctx.pipeToSelf(
                invokeSCR(op.urn, op.input),
                (reply) => ({ type: '_parallelReply' as const, index: idx, reply }),
                (err) => ({ type: '_parallelReply' as const, index: idx, reply: { type: 'error' as const, error: String(err) } })
              )
            })
          }
        } else if (state.urn === 'scr:operator:workflows.retry') {
          state.retryUrn = state.input.urn
          state.retryInput = state.input.input
          state.maxAttempts = state.input.maxAttempts || 1
          state.backoffMs = state.input.backoffMs || 0
          state.attempts = 1
          executeRetryTurn(state, ctx)
        } else if (state.urn === 'scr:operator:workflows.branch') {
          state.branchBranches = state.input.branches || {}
          state.branchDefault = state.input.defaultBranch
          
          if (state.input.conditionUrn) {
            state.branchPhase = 'condition'
            ctx.pipeToSelf(
              invokeSCR(state.input.conditionUrn, state.input.conditionInput),
              (reply) => ({ type: '_conditionReply' as const, reply }),
              (err) => ({ type: '_conditionReply' as const, reply: { type: 'error' as const, error: String(err) } })
            )
          } else {
            // Evaluate simple equality
            const isMatch = JSON.stringify(state.input.value) === JSON.stringify(state.input.expected)
            const key = isMatch ? 'true' : 'false'
            const branchOp = state.branchBranches[key] || (state.branchDefault ? state.branchBranches[state.branchDefault] : null)

            if (!branchOp) {
              if (state.replyTo) {
                state.replyTo.send({ type: 'error', error: `Branch not found for key "${key}" and no default branch specified.` })
              }
              cleanup(state)
              ctx.stop(ctx.self)
              return { state }
            }

            state.branchPhase = 'target'
            ctx.pipeToSelf(
              invokeSCR(branchOp.urn, branchOp.input !== undefined ? branchOp.input : state.input),
              (reply) => ({ type: '_stepReply' as const, reply }),
              (err) => ({ type: '_stepReply' as const, reply: { type: 'error', error: String(err) } })
            )
          }
        }

        return { state }
      },

      _persistenceRef: (state, msg) => {
        return {
          state: { ...state, persistenceRef: msg.ref },
        }
      },

      _stepReply: (state, msg, ctx) => {
        const { reply } = msg

        if (reply.type === 'pending') {
          handlePending(state, reply.jobId, reply.placeholderText, ctx)
          return { state }
        }

        if (state.urn === 'scr:operator:workflows.sequence' || (state.urn === 'scr:operator:workflows.map' && state.input.concurrency === 'sequence')) {
          if (reply.type === 'result') {
            state.results.push(reply.output)
            state.currentIndex++
            executeNextStep(state, ctx)
          } else {
            // Error
            if (state.replyTo) {
              state.replyTo.send({ type: 'error', error: reply.error })
            }
            cleanup(state)
            ctx.stop(ctx.self)
          }
        } else if (state.urn === 'scr:operator:workflows.fallback') {
          if (reply.type === 'result') {
            if (state.replyTo) {
              state.replyTo.send(reply)
            }
            cleanup(state)
            ctx.stop(ctx.self)
          } else {
            // Record failure error and try next
            state.results.push(reply.error)
            state.currentIndex++
            executeNextFallback(state, ctx)
          }
        } else if (state.urn === 'scr:operator:workflows.retry') {
          if (reply.type === 'result') {
            if (state.replyTo) {
              state.replyTo.send(reply)
            }
            cleanup(state)
            ctx.stop(ctx.self)
          } else {
            if (state.attempts < state.maxAttempts) {
              state.attempts++
              executeRetryTurn(state, ctx)
            } else {
              if (state.replyTo) {
                state.replyTo.send({ type: 'error', error: `Retry failed after ${state.maxAttempts} attempts. Last error: ${reply.error}` })
              }
              cleanup(state)
              ctx.stop(ctx.self)
            }
          }
        } else if (state.urn === 'scr:operator:workflows.branch') {
          // This is the target branch execution reply
          if (state.replyTo) {
            state.replyTo.send(reply)
          }
          cleanup(state)
          ctx.stop(ctx.self)
        }

        return { state }
      },

      _parallelReply: (state, msg, ctx) => {
        const { index, reply } = msg
        state.results[index] = reply
        state.activeCount--

        if (state.activeCount === 0) {
          // Process all parallel replies
          const errors = state.results.filter((r: any) => r.type === 'error')
          const pendings = state.results.filter((r: any) => r.type === 'pending')

          if (errors.length > 0) {
            if (state.replyTo) {
              state.replyTo.send({
                type: 'error',
                error: `Parallel execution failed: ${errors.map((e: any) => e.error).join('; ')}`,
              })
            }
            cleanup(state)
            ctx.stop(ctx.self)
            return { state }
          }

          if (pendings.length > 0) {
            // Register all pending jobs
            pendings.forEach((p: any) => {
              state.spawnerRef.send({
                type: 'registerJob',
                jobId: p.jobId,
                runId: state.runId,
                urn: state.urn,
              })
            })

            // Track pending jobs locally
            state.pendingJobs = {}
            state.results.forEach((r: any, idx: number) => {
              if (r.type === 'pending') {
                state.pendingJobs[r.jobId] = { operandIndex: idx, jobId: r.jobId }
              }
            })

            const firstPending = pendings[0] as any
            if (state.replyTo) {
              state.replyTo.send({
                type: 'pending',
                jobId: firstPending.jobId,
                placeholderText: firstPending.placeholderText || `Waiting on concurrent branch: ${firstPending.jobId}`,
              })
            }
            ctx.stop(ctx.self)
            return { state }
          }

          // All succeeded
          const outputs = state.results.map((r: any) => r.output)
          if (state.replyTo) {
            state.replyTo.send({
              type: 'result',
              output: { results: outputs },
            })
          }
          cleanup(state)
          ctx.stop(ctx.self)
        }

        return { state }
      },

      _conditionReply: (state, msg, ctx) => {
        const { reply } = msg

        if (reply.type === 'pending') {
          handlePending(state, reply.jobId, reply.placeholderText, ctx)
          return { state }
        }

        if (reply.type === 'error') {
          if (state.replyTo) {
            state.replyTo.send({ type: 'error', error: `Branch condition evaluation failed: ${reply.error}` })
          }
          cleanup(state)
          ctx.stop(ctx.self)
          return { state }
        }

        // Output of condition is expected to be a string key or primitive, or object containing a key
        let key = 'false'
        if (reply.output !== undefined && reply.output !== null) {
          if (typeof reply.output === 'object') {
            key = String((reply.output as any).branch || (reply.output as any).result || JSON.stringify(reply.output))
          } else {
            key = String(reply.output)
          }
        }

        const branchOp = state.branchBranches[key] || (state.branchDefault ? state.branchBranches[state.branchDefault] : null)
        if (!branchOp) {
          if (state.replyTo) {
            state.replyTo.send({ type: 'error', error: `Branch not found for condition result "${key}" and no default branch specified.` })
          }
          cleanup(state)
          ctx.stop(ctx.self)
          return { state }
        }

        state.branchPhase = 'target'
        ctx.pipeToSelf(
          invokeSCR(branchOp.urn, branchOp.input !== undefined ? branchOp.input : state.input),
          (rep) => ({ type: '_stepReply' as const, reply: rep }),
          (err) => ({ type: '_stepReply' as const, reply: { type: 'error', error: String(err) } })
        )

        return { state }
      },

      _jobCompleted: (state, msg, ctx) => {
        const { jobId, reply } = msg

        // Convert the job reply format back to SCRReply
        let scrReply: SCRReply
        if (reply.type === 'toolResult') {
          let output = reply.result
          if (reply.result?.outputs) {
            output = reply.result.outputs
          } else if (reply.result?.text) {
            try {
              const parsed = JSON.parse(reply.result.text)
              if (parsed && typeof parsed === 'object') {
                output = parsed
              }
            } catch {}
          }
          scrReply = { type: 'result', output }
        } else {
          scrReply = { type: 'error', error: reply.error || 'Job failed' }
        }

        if (state.urn === 'scr:operator:workflows.sequence' || (state.urn === 'scr:operator:workflows.map' && state.input.concurrency === 'sequence')) {
          ctx.send(ctx.self, { type: '_stepReply', reply: scrReply })
        } else if (state.urn === 'scr:operator:workflows.fallback') {
          ctx.send(ctx.self, { type: '_stepReply', reply: scrReply })
        } else if (state.urn === 'scr:operator:workflows.retry') {
          ctx.send(ctx.self, { type: '_stepReply', reply: scrReply })
        } else if (state.urn === 'scr:operator:workflows.branch') {
          if (state.branchPhase === 'condition') {
            ctx.send(ctx.self, { type: '_conditionReply', reply: scrReply })
          } else {
            ctx.send(ctx.self, { type: '_stepReply', reply: scrReply })
          }
        } else if (state.urn === 'scr:operator:workflows.parallel' || state.urn === 'scr:operator:workflows.map') {
          // Parallel execution resumption
          const pending = state.pendingJobs[jobId]
          if (pending) {
            const idx = pending.operandIndex
            delete state.pendingJobs[jobId]
            state.results[idx] = scrReply
            
            // Re-check if there are any remaining pending jobs
            const remainingPending = Object.keys(state.pendingJobs)
            if (remainingPending.length === 0) {
              // All completed! Process parallel replies
              state.activeCount = 0 // already resolved, just mock it to trigger completion processing
              ctx.send(ctx.self, { type: '_parallelReply', index: idx, reply: scrReply })
            } else {
              // Wait for other jobs to complete
              if (state.replyTo) {
                // Return another pending response to keep caller updated
                state.replyTo.send({
                  type: 'pending',
                  jobId: remainingPending[0] || '',
                  placeholderText: `Waiting on remaining concurrent branches`,
                })
              }
            }
          }
        }

        return { state }
      },
    }),
  }
}
