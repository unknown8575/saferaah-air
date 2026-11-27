// Google services used by the server, all optional and all keyed by environment
// variables (never shipped to the browser):
//   GEMINI_API_KEY        Gemini API key (Google AI Studio)
//   GEMINI_VERTEX         1 = Gemini on Vertex AI with the Cloud Run service account (no key);
//                         on by default on Cloud Run when there is no key
//   GEMINI_MODEL          text model to try first (then newer stable names are tried)
//   GEMINI_EMBED_MODEL    embedding model, default "gemini-embedding-001"
//   GOOGLE_AIR_KEY        Google Air Quality API key (current conditions, CPCB AQI)
//   GEMINI_DAILY_LIMIT    most Gemini answers per day for the whole server (default 500)
// Without them the assistant uses its built-in engine and air comes from Open-Meteo.
import { createHash } from 'node:crypto';
import {
  parseOpenMeteo,
  parseWeather,
  parseSensors,
  aqiFrom,
  AIR_URL,
  WEATHER_URL,
  type AirNow,
} from '../shared/air.ts';
import { NOTES } from '../shared/saans/knowledge.ts';
import { cosine } from '../shared/saans/retrieve.ts';
import {
  buildPrompt,
  compose,
  groundingNotes,
  cleanModelText,
  factsFor,
  type Answer,
  type AssistantContext,
  type Turn,
} from '../shared/saans/assistant.ts';

export type Fetch = typeof fetch;
const GL = 'https://generativelanguage.googleapis.com/v1beta';

export interface AiConfig {
  geminiKey?: string;
  model?: string;
  embedModel?: string;
  airKey?: string;
  /** use Gemini on Vertex AI with the server's Google Cloud identity (no key; billed to the project) */
  vertex?: boolean;
  /** Google Cloud project id for Vertex AI (default: from the metadata server) */
  project?: string;
  /** most Gemini answers per day for the whole server (then the built-in engine answers) */
  dailyLimit?: number;
  /** persistent counter: adds one to `name` for `day` and returns the new count (see db.bump) */
  counter?: (name: string, day: string) => number;
  fetch?: Fetch;
  now?: () => number;
}
export function aiConfigFromEnv(): AiConfig {
  return {
    geminiKey: process.env.GEMINI_API_KEY || undefined,
    model: process.env.GEMINI_MODEL || undefined,
    embedModel: process.env.GEMINI_EMBED_MODEL || undefined,
    airKey: process.env.GOOGLE_AIR_KEY || undefined,
    // on Cloud Run (K_SERVICE is set) with no key, use Vertex AI unless GEMINI_VERTEX=0
    vertex:
      process.env.GEMINI_VERTEX === '1' ||
      (!process.env.GEMINI_API_KEY && !!process.env.K_SERVICE && process.env.GEMINI_VERTEX !== '0'),
    project: process.env.GOOGLE_CLOUD_PROJECT || undefined,
    dailyLimit: process.env.GEMINI_DAILY_LIMIT ? Number(process.env.GEMINI_DAILY_LIMIT) : undefined,
  };
}

/** The parts of a Gemini / Vertex response this client reads. */
interface GeminiResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  modelVersion?: string;
  error?: { message?: string };
  embeddings?: { values: number[] }[];
  predictions?: { embeddings?: { values: number[] } }[];
}
/** Google Air Quality "current conditions" (only what we use). */
interface GoogleAirResponse {
  dateTime?: string;
  pollutants?: { code: string; concentration?: { value?: number } }[];
}
type GenerateBody = { generationConfig?: Record<string, unknown> } & Record<string, unknown>;
type Reply = Answer & { fallback?: boolean; reason?: string; cached?: boolean };
const statusOf = (err: unknown): number | undefined => (err as { status?: number }).status;

/** The visible answer text and why the model stopped. */
export function readCandidate(j: GeminiResponse): { text: string; finish: string } {
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((x) => !x.thought && typeof x.text === 'string')
    .map((x) => x.text)
    .join('')
    .trim();
  return { text, finish: cand?.finishReason ?? 'STOP' };
}

async function withTimeout<T>(ms: number, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await f(ctl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** Model names to try, newest first; the first that answers is kept (GEMINI_MODEL goes in front). */
const MODEL_CANDIDATES = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];
/**
 * Gemini counts its thinking tokens against this limit too, so it must leave room for both.
 * Answer length is kept short by the instruction (≤ 140 words), not by this cap.
 */
const MAX_OUTPUT_TOKENS = 2048;

/**
 * Saans answers from facts computed in code, so deep reasoning adds seconds, not accuracy:
 * Gemini 3 models get the low thinking level, 2.5 Flash models none. Unknown names get no
 * setting, and a model that rejects the setting (400) is retried once without it.
 */
export function thinkingFor(model: string): Record<string, unknown> | undefined {
  if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
  if (model.startsWith('gemini-2.5-flash')) return { thinkingBudget: 0 };
  return undefined;
}
const META = 'http://metadata.google.internal/computeMetadata/v1';
const CACHE_MS = 10 * 60000;
const CACHE_MAX = 300;
const AIR_CACHE_MAX = 200;
const BREAKER_FAILS = 3;
const BREAKER_MS = 60000;

export class Ai {
  private f: Fetch;
  private models: string[];
  /** models that rejected the thinking setting (400), asked without it from then on */
  private noThinking = new Set<string>();
  private embedModel: string;
  private noteVecs: number[][] | null = null;
  private embedRetryAt = 0;
  private airCache = new Map<string, { at: number; v: AirNow | null }>();
  private day = { key: '', used: 0 };
  private token: { value: string; until: number } | null = null;
  /** circuit breaker: after BREAKER_FAILS failures in a row, skip Gemini for BREAKER_MS */
  private fails = 0;
  private openUntil = 0;
  /** recent Gemini answers by question + facts (same question, same air → same answer, no cost) */
  private cache = new Map<string, { at: number; a: Answer }>();
  private project: string | null;
  constructor(private cfg: AiConfig) {
    this.f = cfg.fetch ?? fetch;
    this.models = cfg.model ? [cfg.model, ...MODEL_CANDIDATES.filter((m) => m !== cfg.model)] : [...MODEL_CANDIDATES];
    // Vertex's multilingual model embeds a whole batch in one call (and knows Hindi)
    this.embedModel = cfg.embedModel ?? (cfg.geminiKey ? 'gemini-embedding-001' : 'text-multilingual-embedding-002');
    this.project = cfg.project ?? null;
  }
  /** Gemini through an AI Studio key, or through Vertex AI with the service's own identity. */
  get mode(): 'key' | 'vertex' | null {
    return this.cfg.geminiKey ? 'key' : this.cfg.vertex ? 'vertex' : null;
  }
  get hasGemini() {
    return this.mode !== null;
  }
  get hasGoogleAir() {
    return !!this.cfg.airKey;
  }
  private get now() {
    return (this.cfg.now ?? Date.now)();
  }

  /** Count one Gemini answer against today's cap; false when the cap is reached. */
  private takeQuota(): boolean {
    const key = new Date(this.now).toISOString().slice(0, 10);
    const limit = this.cfg.dailyLimit ?? 500;
    // with a database the count survives restarts and new instances; without one it is in memory
    if (this.cfg.counter) return this.cfg.counter('gemini', key) <= limit;
    if (this.day.key !== key) this.day = { key, used: 0 };
    if (this.day.used >= limit) return false;
    this.day.used++;
    return true;
  }

  /** Vertex AI: an access token for the Cloud Run service account, from the metadata server. */
  private async vertexAuth(): Promise<{ token: string; project: string }> {
    if (!this.token || this.token.until < this.now) {
      const r = await this.f(`${META}/instance/service-accounts/default/token`, {
        headers: { 'Metadata-Flavor': 'Google' },
      });
      if (!r.ok) throw new Error(`metadata token ${r.status}`);
      const j = await r.json();
      this.token = { value: j.access_token, until: this.now + (Number(j.expires_in ?? 300) - 60) * 1000 };
    }
    if (!this.project) {
      const r = await this.f(`${META}/project/project-id`, { headers: { 'Metadata-Flavor': 'Google' } });
      if (!r.ok) throw new Error(`metadata project ${r.status}`);
      this.project = (await r.text()).trim();
    }
    return { token: this.token.value, project: this.project };
  }

  /** POST to Gemini. `op` is e.g. "gemini-x:generateContent". */
  private async call(
    model: string,
    op: string,
    body: unknown,
    ms = 25000,
    location = 'global',
  ): Promise<GeminiResponse> {
    return withTimeout(ms, async (signal) => {
      let url: string, headers: Record<string, string>;
      if (this.mode === 'key') {
        url = `${GL}/models/${model}:${op}`;
        headers = { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.geminiKey! };
      } else {
        const a = await this.vertexAuth();
        const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
        url = `https://${host}/v1/projects/${a.project}/locations/${location}/publishers/google/models/${model}:${op}`;
        headers = { 'content-type': 'application/json', authorization: `Bearer ${a.token}` };
      }
      const r = await this.f(url, { method: 'POST', signal, headers, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as GeminiResponse;
      if (!r.ok)
        throw Object.assign(new Error(`Gemini ${r.status}: ${j?.error?.message ?? 'error'}`), { status: r.status });
      return j;
    });
  }

  /** Embed texts (vector search). AI Studio takes a batch; Vertex takes one text per call. */
  private async embed(
    texts: { text: string; title?: string }[],
    task: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
    ms = 15000,
  ): Promise<number[][]> {
    if (this.mode === 'key') {
      const j = await this.call(
        this.embedModel,
        'batchEmbedContents',
        {
          requests: texts.map((t) => ({
            model: `models/${this.embedModel}`,
            taskType: task,
            title: t.title,
            content: { parts: [{ text: t.text }] },
          })),
        },
        ms,
      );
      return (j.embeddings ?? []).map((e) => e.values);
    }
    const j = await this.call(
      this.embedModel,
      'predict',
      {
        instances: texts.map((t) => ({ content: t.text, task_type: task, ...(t.title ? { title: t.title } : {}) })),
      },
      ms,
      'us-central1',
    );
    return (j.predictions ?? []).map((p) => p?.embeddings?.values ?? []);
  }

  /** Embeddings of every note, computed once (vector search); retried later if it failed. */
  private async notesEmbedded(): Promise<number[][] | null> {
    if (this.noteVecs || !this.hasGemini || this.now < this.embedRetryAt) return this.noteVecs;
    try {
      const vecs = await this.embed(
        NOTES.map((n) => ({ title: n.title, text: `${n.title}. ${n.text} ${n.tags}` })),
        'RETRIEVAL_DOCUMENT',
        30000,
      );
      if (vecs.length !== NOTES.length || vecs.some((v) => !v?.length)) throw new Error('embedding count mismatch');
      this.noteVecs = vecs;
    } catch (err) {
      console.warn('[saans] embeddings off for 10 min:', (err as Error).message);
      this.embedRetryAt = this.now + 10 * 60000;
    }
    return this.noteVecs;
  }

  private async dense(q: string): Promise<number[] | undefined> {
    const vecs = await this.notesEmbedded();
    if (!vecs) return undefined;
    try {
      const [qv] = await this.embed([{ text: q }], 'RETRIEVAL_QUERY', 8000);
      return qv?.length ? vecs.map((v) => cosine(qv, v)) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * generateContent on one model: low thinking when it takes it (a 400 means it does not, so ask
   * again without and remember), and one retry after a short wait when the quota is busy (429).
   */
  private async generateOn(m: string, body: GenerateBody): Promise<GeminiResponse> {
    const think = this.noThinking.has(m) ? undefined : thinkingFor(m);
    const withThink = think ? { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: think } } : body;
    try {
      return await this.call(m, 'generateContent', withThink);
    } catch (err) {
      if (statusOf(err) === 400 && think) {
        this.noThinking.add(m);
        return this.call(m, 'generateContent', body);
      }
      if (statusOf(err) !== 429) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      return this.call(m, 'generateContent', withThink);
    }
  }

  /** generateContent on the first model that exists; remembers it. */
  private async generate(body: GenerateBody): Promise<{ j: GeminiResponse; model: string }> {
    let last: unknown;
    const order = this.models.slice(); // the list is re-ordered inside the loop
    for (const m of order) {
      try {
        return { j: await this.generateOn(m, body), model: m };
      } catch (err) {
        last = err;
        // an unknown or retired model (404), or one this billing account may not use (403),
        // moves on to the next name; anything else is a real error
        const st = statusOf(err);
        if (st !== 404 && st !== 403) throw err;
        console.warn(`[saans] model ${m} not available (${st}), trying the next one`);
        this.models = this.models.filter((x) => x !== m).concat(m);
      }
    }
    throw last;
  }

  /** Answer a question: Gemini grounded on our facts and notes, or the built-in engine. */
  async answer(q: string, ctx: AssistantContext, history: Turn[] = []): Promise<Reply> {
    if (this.hasGemini && this.now < this.openUntil)
      return { ...compose(q, ctx), fallback: true, reason: 'Gemini paused after errors' };
    const key = createHash('sha256')
      .update(JSON.stringify([q.trim().toLowerCase(), factsFor(ctx), history]))
      .digest('base64url');
    const hit = this.cache.get(key);
    if (hit && this.now - hit.at < CACHE_MS) return { ...hit.a, cached: true };
    const useGemini = this.hasGemini && this.takeQuota();
    const notes = groundingNotes(q, useGemini ? await this.dense(q) : undefined);
    const base = compose(q, ctx, notes);
    if (!useGemini) return this.hasGemini ? { ...base, fallback: true, reason: 'daily limit reached' } : base;
    try {
      return await this.fromGemini(key, base, buildPrompt(q, ctx, notes, history));
    } catch (err) {
      return this.failed(err, base);
    }
  }

  /** Ask Gemini; only a finished answer is shown and cached. */
  private async fromGemini(key: string, base: Answer, p: ReturnType<typeof buildPrompt>): Promise<Reply> {
    const { j, model } = await this.generate({
      systemInstruction: { parts: [{ text: p.system }] },
      contents: p.contents,
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.4 },
      safetySettings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }],
    });
    const { text, finish } = readCandidate(j);
    // one cut off by the token limit, or stopped for safety or recitation, gives the built-in
    // answer instead and is never cached
    if (finish !== 'STOP') {
      console.warn(`[saans] ${model} stopped with ${finish} after ${text.length} chars; using built-in answer`);
      return { ...base, fallback: true, reason: finish === 'MAX_TOKENS' ? 'answer was cut off' : 'answer withheld' };
    }
    if (!text) throw new Error('empty answer');
    const a: Answer = { ...base, text: cleanModelText(text), engine: 'gemini', model: j.modelVersion ?? model };
    this.fails = 0;
    this.cache.set(key, { at: this.now, a });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!); // oldest first
    return a;
  }

  /** Gemini failed: count it (3 in a row pause Gemini for a minute) and answer from the built-in engine. */
  private failed(err: unknown, base: Answer): Reply {
    console.warn('[saans] Gemini failed, using built-in answer:', (err as Error).message);
    if (++this.fails >= BREAKER_FAILS) {
      this.openUntil = this.now + BREAKER_MS;
      this.fails = 0;
    }
    return { ...base, fallback: true, reason: statusOf(err) === 429 ? 'Gemini is busy' : 'Gemini unavailable' };
  }

  /**
   * Air for a ~10 km cell: CAMS forecast (24-h CPCB AQI), the weather that traps smog, nearby
   * community sensors, and Google's current conditions when keyed. Fetched in parallel; cached
   * 30 min (failures only 2 min, so a blip doesn't hide the air for half an hour); the cache is
   * bounded (oldest entries go first).
   */
  async air(lat: number, lon: number): Promise<AirNow | null> {
    const la = lat.toFixed(1),
      lo = lon.toFixed(1);
    const key = `${la},${lo}`;
    const hit = this.airCache.get(key);
    if (hit && this.now - hit.at < (hit.v ? 30 : 2) * 60000) return hit.v;
    const get = (url: string, ms = 8000) =>
      withTimeout(ms, async (signal) => {
        const r = await this.f(url, { signal });
        return r.ok ? r.json() : null;
      }).catch(() => null);
    const [air, wx, sensors] = await Promise.all([
      get(AIR_URL(la, lo)),
      get(WEATHER_URL(la, lo)),
      get(`https://data.sensor.community/airrohr/v1/filter/area=${la},${lo},8`, 6000),
    ]);
    let v: AirNow | null = air ? parseOpenMeteo(air, new Date(this.now)) : null;
    if (this.hasGoogleAir) v = (await this.googleAir(lat, lon, v).catch(() => null)) ?? v;
    if (v) {
      v.weather = wx ? parseWeather(wx, new Date(this.now)) : null;
      v.ground = sensors ? parseSensors(sensors) : null;
    }
    this.airCache.set(key, { at: this.now, v });
    if (this.airCache.size > AIR_CACHE_MAX) this.airCache.delete(this.airCache.keys().next().value!);
    return v;
  }

  /** Google's current reading (when keyed) on top of the CAMS forecast; null keeps the forecast. */
  private async googleAir(lat: number, lon: number, v: AirNow | null): Promise<AirNow | null> {
    const g = await withTimeout(8000, async (signal) => {
      const r = await this.f('https://airquality.googleapis.com/v1/currentConditions:lookup', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.airKey! },
        body: JSON.stringify({
          location: { latitude: lat, longitude: lon },
          extraComputations: ['POLLUTANT_CONCENTRATION', 'LOCAL_AQI'],
        }),
      });
      return r.ok ? ((await r.json()) as GoogleAirResponse) : null;
    });
    const pm = (code: string) => g?.pollutants?.find((p) => p.code === code)?.concentration?.value;
    const pm25 = pm('pm25');
    const pm10 = pm('pm10');
    if (pm25 == null) return null;
    return {
      ...(v ?? { hours: [] }),
      at: g?.dateTime ?? new Date(this.now).toISOString(),
      pm25,
      pm10: pm10 ?? v?.pm10 ?? pm25 * 1.6,
      // keep the CPCB 24-hour AQI from the forecast when we have it; otherwise this hour's estimate
      aqi: v?.aqi.basis === '24h' ? v.aqi : aqiFrom(pm25, pm10, 'hourly')!,
      source: v ? 'Google Air Quality API (now) + CAMS forecast' : 'Google Air Quality API',
    };
  }
}
