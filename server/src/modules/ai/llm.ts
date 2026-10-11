import Anthropic from '@anthropic-ai/sdk';

/**
 * One way to ask a vision model for JSON, whatever the provider. Prompts and output schemas live
 * with the features (extraction templates, smart intake); a provider only knows how to send them.
 * Switch providers with AI_MODE — no feature code changes.
 */

export type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export type Part = { text: string } | { data: Buffer; mediaType: MediaType };

export interface JsonRequest {
  system: string;
  parts: Part[];
  /** JSON Schema of the answer. */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface VisionModel {
  /** Shown to managers, e.g. "gemini · gemini-flash-latest". */
  readonly name: string;
  json(req: JsonRequest): Promise<unknown>;
  /** US$ spent since the server started, when the provider reports cost. */
  readonly spentUsd?: number;
}

/** The model answered, but not with something usable (declined, cut off, quota). */
export class ModelError extends Error {}

export class ClaudeModel implements VisionModel {
  readonly name: string;
  private client: Anthropic;
  constructor(
    private model: string,
    apiKey?: string,
  ) {
    this.name = `claude · ${model}`;
    // Without an explicit key the SDK resolves ANTHROPIC_API_KEY / auth token / `ant auth login` profile.
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async json(req: JsonRequest): Promise<unknown> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = req.parts.map((p) => {
      if ('text' in p) return { type: 'text', text: p.text };
      const source = { type: 'base64' as const, data: p.data.toString('base64') };
      return p.mediaType === 'application/pdf'
        ? { type: 'document', source: { ...source, media_type: 'application/pdf' } }
        : { type: 'image', source: { ...source, media_type: p.mediaType } };
    });
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 4000,
      // Reading a document is a simple task: low effort keeps it fast and cheap.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
      system: req.system,
      messages: [{ role: 'user', content }],
      // If a safety classifier declines, the API retries on a suitable fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (response.stop_reason === 'refusal')
      throw new ModelError('The model declined to read this input');
    if (response.stop_reason === 'max_tokens')
      throw new ModelError('Too much content — split the screenshot or message');
    const text = response.content.find((b) => b.type === 'text');
    if (text?.type !== 'text') throw new ModelError('No result returned');
    return JSON.parse(text.text);
  }
}

type FetchFn = typeof fetch;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

/** Gemini's schema subset has no `additionalProperties`; strict shape is checked after parsing. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([k]) => k !== 'additionalProperties')
      .map(([k, v]) => [k, geminiSchema(v)]),
  );
}

/**
 * Google Gemini over REST (no SDK needed). The free key from Google AI Studio works, with rate
 * limits — and free-tier inputs may be used by Google, so use test or blurred data on it.
 */
export class GeminiModel implements VisionModel {
  readonly name: string;
  constructor(
    private model: string,
    private apiKey: string,
    private fetchFn: FetchFn = fetch,
  ) {
    this.name = `gemini · ${model}`;
  }

  async json(req: JsonRequest): Promise<unknown> {
    const parts = req.parts.map((p) =>
      'text' in p
        ? { text: p.text }
        : { inlineData: { mimeType: p.mediaType, data: p.data.toString('base64') } },
    );
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: req.maxTokens ?? 8000,
        responseMimeType: 'application/json',
        responseJsonSchema: geminiSchema(req.schema),
      },
    };
    const res = await this.fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
      },
    );
    const out = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (res.status === 429)
      throw new ModelError('Gemini quota reached (free key limit) — wait a minute and try again');
    if (!res.ok)
      throw new ModelError(`Gemini error ${res.status}: ${out.error?.message ?? 'request failed'}`);
    if (out.promptFeedback?.blockReason)
      throw new ModelError(`Gemini declined the input (${out.promptFeedback.blockReason})`);
    const candidate = out.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS')
      throw new ModelError('Too much content — split the screenshot or message');
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text) throw new ModelError(`No result returned (${candidate?.finishReason ?? 'empty'})`);
    try {
      return JSON.parse(text);
    } catch {
      throw new ModelError('Gemini returned text that is not valid JSON');
    }
  }
}

interface OpenRouterResponse {
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

/**
 * OpenRouter (OpenAI-compatible): one key, many models. Pick a cheap vision model with
 * structured outputs, e.g. google/gemini-2.5-flash-lite. Spend is logged per call and summed.
 */
export class OpenRouterModel implements VisionModel {
  readonly name: string;
  /** US$ spent through this server since it started (from OpenRouter's usage accounting). */
  spentUsd = 0;
  constructor(
    private model: string,
    private apiKey: string,
    private fetchFn: FetchFn = fetch,
  ) {
    this.name = `openrouter · ${model}`;
  }

  async json(req: JsonRequest): Promise<unknown> {
    const content = req.parts.map((p) => {
      if ('text' in p) return { type: 'text', text: p.text };
      const url = `data:${p.mediaType};base64,${p.data.toString('base64')}`;
      return p.mediaType === 'application/pdf'
        ? { type: 'file', file: { filename: 'document.pdf', file_data: url } }
        : { type: 'image_url', image_url: { url } };
    });
    const res = await this.fetchFn('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        'x-title': 'VMS EV',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: req.maxTokens ?? 4000,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', strict: true, schema: req.schema },
        },
        // Only route to providers that honour the JSON schema; report the cost of each call.
        provider: { require_parameters: true },
        usage: { include: true },
      }),
    });
    const out = (await res.json().catch(() => ({}))) as OpenRouterResponse;
    if (res.status === 402)
      throw new ModelError('OpenRouter credit is used up — add credit or switch AI_MODE');
    if (res.status === 429)
      throw new ModelError('OpenRouter rate limit reached — wait a minute and try again');
    if (!res.ok || out.error)
      throw new ModelError(
        `OpenRouter error ${res.status}: ${out.error?.message ?? 'request failed'}`,
      );
    const cost = out.usage?.cost ?? 0;
    this.spentUsd += cost;
    console.info(
      `[ai] ${this.model}: ${out.usage?.prompt_tokens ?? '?'} in / ${out.usage?.completion_tokens ?? '?'} out tokens, $${cost.toFixed(5)} (total $${this.spentUsd.toFixed(4)})`,
    );
    const choice = out.choices?.[0];
    if (choice?.message?.refusal) throw new ModelError('The model declined to read this input');
    if (choice?.finish_reason === 'length')
      throw new ModelError('Too much content — split the screenshot or message');
    const text = choice?.message?.content ?? '';
    if (!text) throw new ModelError('No result returned');
    try {
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      throw new ModelError('The model returned text that is not valid JSON');
    }
  }
}
