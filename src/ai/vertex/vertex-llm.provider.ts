import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { AppConfig } from '../../config/configuration';
import {
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmProvider,
} from '../llm-provider';
import {
  extractText,
  toGenerationConfig,
  toVertexContents,
} from './vertex-mapping';

/**
 * Vertex AI (Gemini) implementation of LlmProvider, using the Google Gen AI SDK
 * (`@google/genai`) against the Vertex backend. Auth uses Application Default
 * Credentials (same as Firestore). Network/quota failures are wrapped in a 503
 * so callers surface a clean error instead of leaking SDK internals.
 */
@Injectable()
export class VertexLlmProvider extends LlmProvider {
  private readonly logger = new Logger(VertexLlmProvider.name);
  private readonly client: GoogleGenAI;
  private readonly defaultModel: string;

  constructor(config: ConfigService<AppConfig, true>) {
    super();
    const gcp = config.get('gcp', { infer: true });
    const vertex = config.get('vertex', { infer: true });
    this.client = new GoogleGenAI({
      vertexai: true,
      project: gcp.projectId,
      location: vertex.location,
    });
    this.defaultModel = vertex.hostModel;
  }

  async generate(request: LlmGenerateRequest): Promise<LlmGenerateResult> {
    try {
      const response = await this.client.models.generateContent({
        model: request.model ?? this.defaultModel,
        contents: toVertexContents(request.messages),
        config: {
          ...toGenerationConfig(request),
          systemInstruction: request.system,
        },
      });
      return { text: response.text ?? extractText(response) };
    } catch (error) {
      this.logger.error(
        `Vertex generateContent failed: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'The AI service is temporarily unavailable',
      );
    }
  }
}
