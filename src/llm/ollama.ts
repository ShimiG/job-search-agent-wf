import { z } from 'zod';
import type { CostMeter, UsagePurpose } from './cost.ts';

/*
 * A local model through Ollama (https://ollama.com), for work that doesn't need Claude: it's free and
 * nothing leaves your Mac. Models are named "ollama:<model>", e.g. SCOUT_MODEL=ollama:gemma3:12b.
 */

export const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');

/** "ollama:gemma3:12b" → "gemma3:12b"; anything else isn't a local model. */
export function ollamaModel(name: string | undefined): string | null {
  return name?.startsWith('ollama:') ? name.slice('ollama:'.length) : null;
}

export async function ollamaHasModel(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const { models } = (await res.json()) as { models: Array<{ name: string }> };
    return models.some((m) => m.name === model || m.name === `${model}:latest`);
  } catch {
    return false;
  }
}

/**
 * One chat turn whose answer must match `schema`: Ollama constrains the output to the JSON schema,
 * and the result is validated again here. Temperature 0, so the same input gives the same answer.
 */
export async function ollamaJson<S extends z.ZodType>(opts: {
  model: string;
  system: string;
  user: string;
  schema: S;
  timeoutMs?: number;
  /** Where the call's tokens and time are recorded, and what the call is for. */
  meter?: CostMeter;
  purpose?: UsagePurpose;
  jobId?: number | null;
}): Promise<z.infer<S>> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const name = `ollama:${opts.model}`;
  const purpose = opts.purpose ?? 'score';
  // Set once the model has answered: an answer that turns out unusable still used these tokens.
  let tokens: { inputTokens: number; outputTokens: number } | undefined;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        // Stays loaded between the Archiver's emails and Scout's jobs instead of reloading each time.
        keep_alive: '30m',
        format: z.toJSONSchema(opts.schema),
        // Ollama's default context is too small for the CV, the examples and a long posting. The answer
        // is capped: a small model held to a JSON schema can otherwise run on until the timeout.
        options: { temperature: 0, num_ctx: 16_384, num_predict: 1_024 },
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
    }).catch((err: Error) => {
      if (err.name === 'TimeoutError') throw new Error(`Ollama took longer than ${Math.round((opts.timeoutMs ?? 300_000) / 1000)}s to answer`);
      throw new Error(`Ollama isn't reachable at ${OLLAMA_URL} (${err.message}). Start it with: brew services start ollama`);
    });
    if (!res.ok) throw new Error(`Ollama: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
    tokens = { inputTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 };
    if (body.done_reason === 'length') throw new Error('Ollama ran out of room for its answer');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.message?.content ?? '');
    } catch {
      throw new Error('Ollama returned something other than JSON');
    }
    const answer = opts.schema.parse(parsed);
    opts.meter?.recordLocal(purpose, name, { ...tokens, durationMs: elapsed() }, opts.jobId);
    return answer;
  } catch (err) {
    // One row per call: a failed one, with the tokens it used if the model got as far as answering.
    opts.meter?.fail(purpose, name, err, elapsed(), opts.jobId, tokens);
    throw err;
  }
}
