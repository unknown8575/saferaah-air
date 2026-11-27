// What every route handler gets: the database, the clock, limits and privacy helpers.
import type { IncomingMessage } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Ai } from './ai.ts';
import { MinuteLimiter, SlidingLimiter, clientIp, deviceId } from './http.ts';

export interface AppOptions {
  db: DatabaseSync;
  staticDir?: string;
  graphVersion: string;
  /** ms clock, injectable for tests */
  now?: () => number;
  rateLimitPerMin?: number;
  /** Gemini / Google Air Quality client (optional keys) */
  ai?: Ai;
  /** behind a trusted proxy (Cloud Run): take the client address from X-Forwarded-For */
  trustProxy?: boolean;
}

/**
 * Privacy (see docs/10-privacy.md):
 *  - GPS points of a trip are kept only while the trip is running (for the live link and
 *    to verify the trip) and are deleted the moment it ends.
 *  - At the end the route, destination and name are erased too; what is left (status and
 *    the list of street segments, needed for the optional review) is deleted after the
 *    review, or after REVIEW_WINDOW_MS if the traveller does not answer.
 *  - A review keeps no trip, no comment and no device id: each street gets a vote under its
 *    own one-way pseudonym, so votes cannot be linked to each other, to reports or to trips.
 *    Votes are deleted after a year.
 *  - Live reports are deleted when they expire.
 */
export const REVIEW_WINDOW_MS = 60 * 60 * 1000;
export const ABANDONED_TRIP_MS = 12 * 3600 * 1000;
/** street votes are deleted after a year (by then they would count for less than 6%) */
export const VOTE_LIFETIME_MS = 365 * 86400000;

export interface Ctx {
  db: DatabaseSync;
  opts: AppOptions;
  now: () => number;
  /** general per-key limit (requests per minute) */
  rateLimit: (key: string) => void;
  /** per-phone and per-network limits for the paid assistant */
  aiLimit: (req: IncomingMessage) => void;
  /** a one-way pseudonym: the same phone gets unrelated ids for different purposes */
  pseudo: (purpose: string, dev: string) => string;
  /** delete trip data that is no longer needed */
  purge: () => void;
  device: (req: IncomingMessage) => string;
  ip: (req: IncomingMessage) => string;
}

function serverSecret(db: DatabaseSync): string {
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  const row = db.prepare("SELECT v FROM meta WHERE k = 'secret'").get() as { v: string } | undefined;
  if (row) return row.v;
  const v = randomBytes(32).toString('hex');
  db.prepare("INSERT INTO meta (k, v) VALUES ('secret', ?)").run(v);
  return v;
}

function purger(db: DatabaseSync, now: () => number): () => void {
  return () => {
    const t = now();
    db.prepare(
      `DELETE FROM journeys WHERE (status != 'active' AND status != 'sos' AND COALESCE(ended_at, 0) < ?)
      OR started_at < ?`,
    ).run(t - REVIEW_WINDOW_MS, t - ABANDONED_TRIP_MS);
    db.prepare('DELETE FROM reports WHERE expires_at <= ?').run(t);
    db.prepare('DELETE FROM edge_votes WHERE updated_at < ?').run(t - VOTE_LIFETIME_MS);
  };
}

export function makeContext(opts: AppOptions): Ctx {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const minute = new MinuteLimiter(opts.rateLimitPerMin ?? 240, now);
  const sliding = new SlidingLimiter(now);
  const secret = serverSecret(db);
  const pseudo = (purpose: string, dev: string) =>
    createHmac('sha256', secret).update(`${purpose}:${dev}`).digest('base64url').slice(0, 22);
  const ip = (req: IncomingMessage) => clientIp(req, !!opts.trustProxy);
  const purge = purger(db, now);
  purge();
  setInterval(purge, 5 * 60 * 1000).unref?.();
  return {
    db,
    opts,
    now,
    rateLimit: (key) => minute.take(key),
    // the assistant costs money per call: per phone 20 questions / 10 min, per network address
    // 60 / hour (so a new phone id each time does not get around it); a daily cap sits in Ai
    aiLimit: (req) => {
      sliding.take(
        'd:' + pseudo('ai', deviceId(req)),
        20,
        600000,
        'Saans needs a short break. Try again in a few minutes.',
      );
      sliding.take(
        'i:' + pseudo('ai-ip', ip(req)),
        60,
        3600000,
        'Too many questions from this network. Try again in an hour.',
      );
    },
    pseudo,
    purge,
    device: deviceId,
    ip,
  };
}

/** A route handler: gets the request and the URL match, returns the JSON to send. */
export type Handler = (req: IncomingMessage, m: RegExpMatchArray) => Promise<unknown>;
export type Routes = Record<string, Handler>;
