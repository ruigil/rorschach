import { createTopic } from '../../system/types.ts'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'

// ─── Shared types ───

export type TokenUsage = { promptTokens: number; completionTokens: number }

export type ModelInfo = { contextWindow: number; promptPer1M: number; completionPer1M: number }

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ApiMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string | UserContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string }

export type Tool = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

// ─── Reply types sent back to the ReAct loop ───

export type LlmProviderReply =
  | { type: 'llmChunk';          requestId: string; text: string }
  | { type: 'llmReasoningChunk'; requestId: string; text: string }
  | { type: 'llmDone';           requestId: string; usage: TokenUsage | null }
  | { type: 'llmToolCalls';      requestId: string; calls: Array<{ id: string; name: string; arguments: string }>; usage: TokenUsage | null }
  | { type: 'llmError';          requestId: string; error: unknown }
  | { type: 'llmImageChunk';     requestId: string; dataUrl: string }

// ─── Incoming messages ───

export type LlmProviderMsg =
  | { type: 'stream';           requestId: string; model: string; messages: ApiMessage[]; tools?: Tool[]; replyTo: ActorRef<LlmProviderReply> }
  | { type: 'streamImage';      requestId: string; model: string; messages: ApiMessage[]; replyTo: ActorRef<LlmProviderReply> }
  | { type: 'fetchModelInfo';   model: string; replyTo: ActorRef<ModelInfo | null> }
  | { type: 'fetchModels';      replyTo: ActorRef<string[]> }
  | { type: '_streamDone';      result: LlmProviderReply; replyTo: ActorRef<LlmProviderReply> }
  | { type: '_streamImageDone'; result: LlmProviderReply; replyTo: ActorRef<LlmProviderReply> }
  | { type: '_modelInfoDone';   info: ModelInfo | null; replyTo: ActorRef<ModelInfo | null> }
  | { type: '_modelsDone';      models: string[]; replyTo: ActorRef<string[]> }

// ─── Retained topic: announces the live llm-provider ref to subscribers ───

export type LlmProviderEvent = { ref: ActorRef<LlmProviderMsg> | null }
export const LlmProviderTopic = createTopic<LlmProviderEvent>('cognitive.llm-provider')

// ─── Adapter interface ───

type AdapterStreamResult =
  | { type: 'content';   usage: TokenUsage | null }
  | { type: 'toolCalls'; calls: Array<{ id: string; name: string; arguments: string }>; usage: TokenUsage | null }

export type LlmProviderAdapter = {
  stream(
    model: string,
    messages: ApiMessage[],
    tools: Tool[] | undefined,
    onChunk: (text: string) => void,
    onReasoningChunk: (text: string) => void,
  ): Promise<AdapterStreamResult>
  streamImage(
    model: string,
    messages: ApiMessage[],
    onChunk: (text: string) => void,
    onImageChunk: (dataUrl: string) => void,
  ): Promise<AdapterStreamResult>
  fetchModelInfo(model: string): Promise<ModelInfo | null>
  fetchModels(): Promise<string[]>
}

// ─── OpenRouter adapter ───

export type OpenRouterAdapterOptions = {
  apiKey: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export const createOpenRouterAdapter = (options: OpenRouterAdapterOptions): LlmProviderAdapter => {
  const { apiKey, reasoning } = options

  return {
    async stream(model, messages, tools, onChunk, onReasoningChunk) {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
          ...(reasoning?.enabled ? { reasoning: { effort: reasoning.effort ?? 'medium' } } : {}),
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter ${res.status}: ${body}`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastUsage: TokenUsage | null = null
      const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {}

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            const calls = Object.values(toolCalls).filter(tc => tc.name)
            if (calls.length > 0) return { type: 'toolCalls', calls, usage: lastUsage }
            return { type: 'content', usage: lastUsage }
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta: {
                  content?: string
                  reasoning?: string
                  tool_calls?: Array<{
                    index: number
                    id?: string
                    function?: { name?: string; arguments?: string }
                  }>
                }
              }>
              usage?: { prompt_tokens: number; completion_tokens: number }
            }
            if (parsed.usage) {
              lastUsage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens }
            }
            const delta = parsed.choices[0]?.delta
            if (delta?.content) onChunk(delta.content)
            if (delta?.reasoning) onReasoningChunk(delta.reasoning)
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' }
                }
                if (tc.function?.arguments) toolCalls[tc.index]!.arguments += tc.function.arguments
              }
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }

      const calls = Object.values(toolCalls).filter(tc => tc.name)
      if (calls.length > 0) return { type: 'toolCalls', calls, usage: lastUsage }
      return { type: 'content', usage: lastUsage }
    },

    async streamImage(model, messages, onChunk, onImageChunk) {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          modalities: ['image', 'text'],
          stream: true,
          stream_options: { include_usage: true },
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter ${res.status}: ${body}`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastUsage: TokenUsage | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') return { type: 'content', usage: lastUsage }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta: {
                  content?: string
                  images?: Array<{ image_url: { url: string } }>
                }
              }>
              usage?: { prompt_tokens: number; completion_tokens: number }
            }
            if (parsed.usage) {
              lastUsage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens }
            }
            const delta = parsed.choices[0]?.delta
            if (delta?.content) onChunk(delta.content)
            if (delta?.images) {
              for (const img of delta.images) onImageChunk(img.image_url.url)
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }

      return { type: 'content', usage: lastUsage }
    },

    async fetchModelInfo(model: string) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        })
        if (!res.ok) return null
        const data = await res.json() as {
          data: Array<{ id: string; context_length: number; pricing: { prompt: string; completion: string } }>
        }
        const entry = data.data.find(m => m.id === model)
        if (!entry) return null
        return {
          contextWindow: entry.context_length,
          promptPer1M: parseFloat(entry.pricing.prompt) * 1_000_000,
          completionPer1M: parseFloat(entry.pricing.completion) * 1_000_000,
        }
      } catch {
        return null
      }
    },

    async fetchModels() {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        })
        if (!res.ok) return []
        const data = await res.json() as { data: Array<{ id: string }> }
        return data.data.map(m => m.id).sort()
      } catch {
        return []
      }
    },
  }
}

// ─── Actor definition ───

export type LlmProviderActorOptions = {
  adapter: LlmProviderAdapter
}

export const createLlmProviderActor = (options: LlmProviderActorOptions): ActorDef<LlmProviderMsg, null> => {
  const { adapter } = options

  return {
    handler: onMessage<LlmProviderMsg, null>({
      stream: (state, message, context) => {
        const { requestId, model, messages, tools, replyTo } = message

        context.pipeToSelf(
          adapter.stream(
            model,
            messages,
            tools,
            (text) => replyTo.send({ type: 'llmChunk', requestId, text }),
            (text) => replyTo.send({ type: 'llmReasoningChunk', requestId, text }),
          ),
          (result): LlmProviderMsg => ({
            type: '_streamDone',
            result: result.type === 'content'
              ? { type: 'llmDone', requestId, usage: result.usage }
              : { type: 'llmToolCalls', requestId, calls: result.calls, usage: result.usage },
            replyTo,
          }),
          (error): LlmProviderMsg => ({
            type: '_streamDone',
            result: { type: 'llmError', requestId, error },
            replyTo,
          }),
        )

        return { state }
      },

      streamImage: (state, message, context) => {
        const { requestId, model, messages, replyTo } = message

        context.pipeToSelf(
          adapter.streamImage(
            model,
            messages,
            (text)   => replyTo.send({ type: 'llmChunk',      requestId, text }),
            (dataUrl) => replyTo.send({ type: 'llmImageChunk', requestId, dataUrl }),
          ),
          (result): LlmProviderMsg => ({
            type: '_streamImageDone',
            result: { type: 'llmDone', requestId, usage: result.usage },
            replyTo,
          }),
          (error): LlmProviderMsg => ({
            type: '_streamImageDone',
            result: { type: 'llmError', requestId, error },
            replyTo,
          }),
        )

        return { state }
      },

      fetchModelInfo: (state, message, context) => {
        const { model, replyTo } = message

        context.pipeToSelf(
          adapter.fetchModelInfo(model),
          (info): LlmProviderMsg => ({ type: '_modelInfoDone', info, replyTo }),
          (): LlmProviderMsg => ({ type: '_modelInfoDone', info: null, replyTo }),
        )

        return { state }
      },

      fetchModels: (state, message, context) => {
        const { replyTo } = message

        context.pipeToSelf(
          adapter.fetchModels(),
          (models): LlmProviderMsg => ({ type: '_modelsDone', models, replyTo }),
          (): LlmProviderMsg => ({ type: '_modelsDone', models: [], replyTo }),
        )

        return { state }
      },

      _streamDone: (state, message) => {
        message.replyTo.send(message.result)
        return { state }
      },

      _streamImageDone: (state, message) => {
        message.replyTo.send(message.result)
        return { state }
      },

      _modelInfoDone: (state, message) => {
        message.replyTo.send(message.info)
        return { state }
      },

      _modelsDone: (state, message) => {
        message.replyTo.send(message.models)
        return { state }
      },
    }),
  }
}
