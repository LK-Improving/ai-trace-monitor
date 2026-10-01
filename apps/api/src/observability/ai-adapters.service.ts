import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAdapterError } from './ai-observation';
import { OpenAiCompatibleClient } from './openai-compatible.client';
import { QdrantRagClient } from './rag.client';
import { TraceContext } from './trace-context';

/** Clients are lazy. Importing the monitoring module never triggers paid/provider calls. */
@Injectable()
export class AiAdaptersService {
  private llmClient?: OpenAiCompatibleClient;
  private ragClient?: QdrantRagClient;

  constructor(private readonly config: ConfigService, private readonly context: TraceContext) {}

  llm(): OpenAiCompatibleClient {
    if (!this.llmClient) {
      const baseUrl = this.config.get<string>('LLM_BASE_URL');
      const apiKey = this.config.get<string>('LLM_API_KEY');
      if (!baseUrl || !apiKey) throw new AiAdapterError('invalid_request');
      this.llmClient = new OpenAiCompatibleClient(this.context, {
        baseUrl, apiKey, timeoutMs: this.timeout('LLM_TIMEOUT_MS'),
      });
    }
    return this.llmClient;
  }

  rag(): QdrantRagClient {
    if (!this.ragClient) {
      const baseUrl = this.config.get<string>('RAG_QDRANT_URL');
      const collection = this.config.get<string>('RAG_QDRANT_COLLECTION');
      if (!baseUrl || !collection) throw new AiAdapterError('invalid_request');
      this.ragClient = new QdrantRagClient(this.context, {
        baseUrl, collection, apiKey: this.config.get<string>('RAG_QDRANT_API_KEY') || undefined,
        timeoutMs: this.timeout('RAG_TIMEOUT_MS'),
      });
    }
    return this.ragClient;
  }

  private timeout(key: string): number | undefined {
    const value = this.config.get<string>(key);
    if (!value) return undefined;
    const milliseconds = Number(value);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 100 || milliseconds > 120_000) {
      throw new AiAdapterError('invalid_request');
    }
    return milliseconds;
  }
}
