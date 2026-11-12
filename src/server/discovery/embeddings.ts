/** Turns item text into vectors for similar-item search. */
export interface Embedder {
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Any OpenAI-compatible embeddings endpoint. The intended default is a
 * local model through Ollama (EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1,
 * EMBEDDING_MODEL=nomic-embed-text), so mail text is not sent to another
 * provider.
 */
export function openAiEmbedder(options: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): Embedder {
  const request = options.fetch ?? fetch;
  return {
    model: options.model,
    async embed(texts, signal) {
      if (!texts.length) return [];
      const response = await request(
        `${options.baseUrl.replace(/\/+$/, '')}/embeddings`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey
              ? { authorization: `Bearer ${options.apiKey}` }
              : {}),
          },
          body: JSON.stringify({ model: options.model, input: texts }),
          signal: signal ?? AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok)
        throw new Error(
          `The embedding model answered ${response.status}. Check EMBEDDING_BASE_URL and EMBEDDING_MODEL.`,
        );
      const body = (await response.json()) as {
        data?: { index?: number; embedding?: unknown }[];
      };
      const data = [...(body.data ?? [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      if (
        data.length !== texts.length ||
        data.some(
          (row) =>
            !Array.isArray(row.embedding) ||
            !row.embedding.length ||
            row.embedding.some((value) => typeof value !== 'number'),
        )
      )
        throw new Error('The embedding model returned no usable vectors.');
      return data.map((row) => row.embedding as number[]);
    },
  };
}

/** The embedder from EMBEDDING_* settings, or undefined when not set. */
export function embedderFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Embedder | undefined {
  const baseUrl = env.EMBEDDING_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return openAiEmbedder({
    baseUrl,
    model: env.EMBEDDING_MODEL?.trim() || 'nomic-embed-text',
    apiKey: env.EMBEDDING_API_KEY?.trim() || undefined,
    fetch: fetchImpl,
  });
}

/** The text embedded for an item. */
export const embeddingText = (item: { title: string; summary: string }) =>
  `${item.title}\n${item.summary}`.slice(0, 4000);
