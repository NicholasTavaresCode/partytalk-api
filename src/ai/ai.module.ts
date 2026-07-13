import { Global, Module } from '@nestjs/common';
import { LlmProvider } from './llm-provider';
import { VertexLlmProvider } from './vertex/vertex-llm.provider';

/**
 * Provides the LlmProvider abstraction bound to Vertex AI (Gemini). Global so
 * both the Rooms AI host and IELTS scoring can inject it. Rebinding to a
 * different provider (or a fake) is a one-line change here.
 */
@Global()
@Module({
  providers: [{ provide: LlmProvider, useClass: VertexLlmProvider }],
  exports: [LlmProvider],
})
export class AiModule {}
