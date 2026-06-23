import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask } from '../system/index.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import { JobRegistryTopic, type ToolReply, type JobLifecycleEvent } from '../types/tools.ts'
import { DocsAgent, updateDocsTool } from '../plugins/coding/docs-agent.ts'
import { ArtifactTools, writeDocPageTool } from '../plugins/coding/artifact-tools.ts'
import type { DocsAgentMsg } from '../plugins/coding/types.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const makeDir = async (prefix: string): Promise<string> => {
  const dir = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`)
  tempDirs.push(dir)
  await mkdir(dir, { recursive: true })
  return dir
}

const tick = (ms = 50) => Bun.sleep(ms)

describe('DocsAgent Concurrency Integration', () => {
  test('handles concurrent update_docs requests using child executors and serializes writes', async () => {
    const system = await AgentSystem()
    const artifactsDir = await makeDir('rorschach-artifacts')

    // 1. Spawn dependencies and DocsAgent
    const artifactToolsRef = system.spawn('artifacts-tools', ArtifactTools(artifactsDir))
    
    const docsAgentRef = system.spawn('docs-coordinator', DocsAgent({
      model: 'test-model',
      maxToolLoops: 5,
      projectMount: '/mount',
      artifactsDir,
      tools: {
        write_doc_page: {
          ...writeDocPageTool,
          ref: artifactToolsRef as any,
        },
      },
    }))

    // 2. Mock LLM Provider
    const llmCalls: any[] = []
    const llmDef = {
      initialState: null,
      handler: (state: null, msg: LlmProviderMsg) => {
        if (msg.type === 'stream') {
          llmCalls.push(msg)
        }
        return { state }
      },
    }
    const llmRef = system.spawn('mock-llm', llmDef)
    system.publish(LlmProviderTopic, { ref: llmRef })
    await tick()

    // 3. Subscribe to JobRegistryTopic to record progress events
    const jobEvents: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, (event) => {
      jobEvents.push(event)
    })

    // 4. Send two concurrent update_docs tool invocations
    const reply1Promise = ask<DocsAgentMsg, ToolReply>(docsAgentRef, (replyTo) => ({
      type: 'invoke',
      toolName: 'update_docs',
      arguments: JSON.stringify({ query: 'Write docs for Module A' }),
      userId: 'user-1',
      replyTo,
    }))

    const reply2Promise = ask<DocsAgentMsg, ToolReply>(docsAgentRef, (replyTo) => ({
      type: 'invoke',
      toolName: 'update_docs',
      arguments: JSON.stringify({ query: 'Write docs for Module B' }),
      userId: 'user-2',
      replyTo,
    }))

    const [reply1, reply2] = await Promise.all([reply1Promise, reply2Promise])

    // Verify both tasks receive toolPending status and different job IDs
    expect(reply1.type).toBe('toolPending')
    expect(reply2.type).toBe('toolPending')

    const jobId1 = (reply1 as any).jobId
    const jobId2 = (reply2 as any).jobId
    expect(jobId1).toBeDefined()
    expect(jobId2).toBeDefined()
    expect(jobId1).not.toBe(jobId2)

    await tick()

    // Verify two LLM calls were made (one for each spawned child executor)
    expect(llmCalls.length).toBe(2)

    const call1 = llmCalls.find(c => c.messages[1].content.includes('Module A'))
    const call2 = llmCalls.find(c => c.messages[1].content.includes('Module B'))
    expect(call1).toBeDefined()
    expect(call2).toBeDefined()

    // 5. Send tool call replies from LLM to write pages concurrently
    call1.replyTo.send({
      type: 'llmToolCalls',
      requestId: call1.requestId,
      calls: [{
        id: 'tc-1',
        name: 'write_doc_page',
        arguments: JSON.stringify({
          title: 'Module A Docs',
          filename: 'module-a.html',
          summary: 'Summary A',
          bodyHtml: '<p>Body A</p>',
          sourcePaths: ['a.ts'],
        }),
      }],
      usage: { promptTokens: 10, completionTokens: 10 },
    })

    call2.replyTo.send({
      type: 'llmToolCalls',
      requestId: call2.requestId,
      calls: [{
        id: 'tc-2',
        name: 'write_doc_page',
        arguments: JSON.stringify({
          title: 'Module B Docs',
          filename: 'module-b.html',
          summary: 'Summary B',
          bodyHtml: '<p>Body B</p>',
          sourcePaths: ['b.ts'],
        }),
      }],
      usage: { promptTokens: 10, completionTokens: 10 },
    })

    let retries = 50
    while (llmCalls.length < 4 && retries > 0) {
      await tick(100)
      retries--
    }

    // Verify the LLM calls are processed and executors move to the next loop
    // Stream calls for completion
    const streamCalls = llmCalls.slice(2)
    expect(streamCalls.length).toBe(2)

    const completionCall1 = streamCalls.find(c => c.messages[1].content.includes('Module A'))
    const completionCall2 = streamCalls.find(c => c.messages[1].content.includes('Module B'))
    expect(completionCall1).toBeDefined()
    expect(completionCall2).toBeDefined()

    completionCall1.replyTo.send({
      type: 'llmDone',
      requestId: completionCall1.requestId,
      usage: { promptTokens: 5, completionTokens: 5 },
    })

    completionCall2.replyTo.send({
      type: 'llmDone',
      requestId: completionCall2.requestId,
      usage: { promptTokens: 5, completionTokens: 5 },
    })

    retries = 50
    while ((!jobEvents.find(e => e.jobId === jobId1 && e.status === 'completed') ||
            !jobEvents.find(e => e.jobId === jobId2 && e.status === 'completed')) && retries > 0) {
      await tick(100)
      retries--
    }

    // Verify both jobs complete successfully
    const completed1 = jobEvents.find(e => e.jobId === jobId1 && e.status === 'completed')
    const completed2 = jobEvents.find(e => e.jobId === jobId2 && e.status === 'completed')
    expect(completed1).toBeDefined()
    expect(completed2).toBeDefined()

    // 6. Verify manifest file contents
    const manifestFile = Bun.file(join(artifactsDir, 'manifest.json'))
    expect(await manifestFile.exists()).toBe(true)
    const manifest = await manifestFile.json()
    expect(manifest.pages.length).toBe(2)
    const filenames = manifest.pages.map((p: any) => p.filename)
    expect(filenames).toContain('module-a.html')
    expect(filenames).toContain('module-b.html')

    await system.shutdown()
  })
})
