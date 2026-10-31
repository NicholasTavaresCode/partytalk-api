import { Global, Module } from '@nestjs/common';
import { LlmProvider } from './llm-provider';
import { VertexLlmProvider } from './vertex/vertex-llm.provider';

/**
 * Provides the LlmProvider abstraction bound to Vertex AI (Gemini). Global so
 * any feature (today: the rooms' AI host) can inject it. Rebinding to a
 * different provider (or a fake) is a one-line change here.
 */
@Global()
@Module({
  providers: [{ provide: LlmProvider, useClass: VertexLlmProvider }],
  exports: [LlmProvider],
})
export class AiModule {}
