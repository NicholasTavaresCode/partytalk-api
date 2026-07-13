/**
 * Provider-agnostic LLM contract. The AI host and IELTS scoring depend on this
 * abstract class (used as a DI token), never on a concrete SDK, so Vertex/Gemini
 * can be swapped for another provider — or a deterministic fake in tests —
 * without touching business logic (di-use-interfaces-tokens).
 */
export type LlmRole = 'user' | 'model';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmGenerateRequest {
  /** Model id override; falls back to the provider's configured default. */
  model?: string;
  /** System instruction that steers behavior (persona, rubric, constraints). */
  system?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Request strict JSON output (used by rubric scoring). */
  json?: boolean;
}

export interface LlmGenerateResult {
  text: string;
}

export abstract class LlmProvider {
  abstract generate(request: LlmGenerateRequest): Promise<LlmGenerateResult>;
}
