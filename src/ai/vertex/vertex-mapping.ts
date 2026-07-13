import { LlmGenerateRequest, LlmMessage } from '../llm-provider';

/** Vertex `Content` shape — kept local to avoid leaking the SDK type outward. */
export interface VertexContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

export interface VertexGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
}

/**
 * Pure translation from our transport-neutral messages to Vertex `contents`.
 * Extracted from the provider so it can be unit-tested without the SDK.
 */
export function toVertexContents(messages: LlmMessage[]): VertexContent[] {
  return messages.map((message) => ({
    role: message.role,
    parts: [{ text: message.content }],
  }));
}

export function toGenerationConfig(
  request: LlmGenerateRequest,
): VertexGenerationConfig {
  const config: VertexGenerationConfig = {};
  if (request.temperature !== undefined) {
    config.temperature = request.temperature;
  }
  if (request.maxOutputTokens !== undefined) {
    config.maxOutputTokens = request.maxOutputTokens;
  }
  if (request.json) {
    config.responseMimeType = 'application/json';
  }
  return config;
}

/**
 * Concatenate the text parts of a Vertex candidate into a single string,
 * tolerating missing/empty candidates.
 */
export function extractText(response: {
  candidates?: {
    content?: { parts?: { text?: string }[] };
  }[];
}): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}
