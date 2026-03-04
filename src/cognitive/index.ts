/** Barrel export for the cognitive capabilities module. */

// Core types
export type {
  ChatRole,
  ChatMessage,
  CompletionOptions,
  TokenUsage,
  CompletionResult,
  ModelProviderConfig,
  ModelProvider,
  CognitiveEvents,
} from "./types";
export { ProviderError } from "./types";

// Providers
export { OpenRouterProvider } from "./openrouter";

// Cognitive Agent
export { CognitiveAgent } from "./cognitive-agent";
export type { CognitiveAgentOptions } from "./cognitive-agent";

// Examples
export { ThinkerAgent } from "./examples/thinker";
export type { ThinkerEvents } from "./examples/thinker";
