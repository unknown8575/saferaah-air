// Health, the air near you, and the Saans assistant.
import { inCoverageArea } from '../../shared/air.ts';
import { smsConfigured } from '../notify.ts';
import { HttpError, readBody } from '../http.ts';
import { assistantContext, chatHistory, obj } from '../validate.ts';
import type { Ctx, Routes } from '../context.ts';

export function airRoutes(ctx: Ctx): Routes {
  const { opts } = ctx;
  return {
    'GET /api/health': async () => ({
      ok: true,
      graphVersion: opts.graphVersion,
      sms: smsConfigured(),
      gemini: !!opts.ai?.hasGemini,
      googleAir: !!opts.ai?.hasGoogleAir,
    }),

    // Air now + next 24 h for a ~10 km cell. Nothing about the request is stored.
    'GET /api/air': async (req) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const lat = Number(u.searchParams.get('lat'));
      const lon = Number(u.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, 'Invalid position');
      // this service only has street data and advice for Delhi NCT, so it only proxies air data there
      if (!inCoverageArea(lat, lon)) throw new HttpError(400, 'Air data is available for Delhi NCT only');
      if (!opts.ai) throw new HttpError(503, 'Air data not configured');
      const v = await opts.ai.air(Math.round(lat * 10) / 10, Math.round(lon * 10) / 10);
      if (!v) throw new HttpError(502, 'Air data unavailable');
      return v;
    },

    // Saans assistant. Questions and answers are not logged or stored.
    'POST /api/assistant': async (req) => {
      ctx.device(req);
      ctx.aiLimit(req);
      const b = obj(await readBody(req));
      const q = typeof b.q === 'string' ? b.q.trim().slice(0, 500) : '';
      if (!q) throw new HttpError(400, 'Ask a question');
      if (!opts.ai) throw new HttpError(503, 'Assistant not configured');
      const a = await opts.ai.answer(q, assistantContext(b.ctx), chatHistory(b.history));
      return {
        text: a.text,
        notes: a.notes,
        cluster: a.cluster,
        plan: a.plan,
        engine: a.engine,
        model: a.model ?? null,
        fallback: a.fallback ?? false,
        reason: a.reason ?? null,
        cached: a.cached ?? false,
      };
    },
  };
}
