// The messages the page and the routing worker exchange (worker.ts answers, app.ts `rpc` asks).
import type { RouteResult } from '../../shared/router.ts';
import type { Profile } from '../../shared/risk.ts';
import type { Poi, PoiCat } from '../../shared/places.ts';
import type { Step } from '../../shared/steps.ts';
import type { Advice } from '../../shared/advice.ts';
import type { Mode } from '../../shared/modes.ts';
import type { Precautions } from '../../shared/precautions.ts';
import type { LiveReport } from '../../shared/live.ts';
import type { LonLat } from '../../shared/geo.ts';
import type { AqiBand } from '../../shared/air.ts';

export type WorkerRoute = Omit<RouteResult, 'edges'> & {
  edges: number[];
  steps: Step[];
  segTier: RouteResult['tier'][];
  havenList: { id: number; name: string; cat: Poi['cat']; lon: number; lat: number; verified: boolean }[];
  precautions: Precautions;
};

export interface RouteReply {
  routes: WorkerRoute[];
  rankedCount: number;
  note?: string;
  error?: string;
  advice: Advice | null;
  /** a warning when the trip means a long time in bad air (shown above the safety advice) */
  airAdvice: Advice | null;
  computeMs: number;
  snapped: { from: LonLat; to: LonLat };
}

/** What the worker reports once the map data is loaded. */
export interface ReadyMeta {
  bbox: [number, number, number, number];
  snapshot: string;
  onewayKnown: boolean;
  nodes: number;
  edges: number;
  air: boolean;
}

/** A map layer of street lines with one number per street. */
export interface LinesFC {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: number[][] };
    properties: Record<string, number>;
  }[];
}

export type NearbyPlace = Poi & { distM: number; open: boolean; verified: boolean };

/** Every request the worker understands. */
export type WorkerRequest =
  | { type: 'init'; base: string; graphParts?: string[] }
  | { type: 'crowd'; stats: [number, number, number][] }
  | {
      type: 'route';
      from: LonLat;
      to: LonLat;
      mode: Mode;
      when: string;
      profile: Profile;
      pm25?: number | null;
      /** trusted contacts who get the arrival message (advice wording depends on it) */
      contacts?: number;
      /** the air now, for the "long time in bad air" warning */
      aqi?: { value: number; band: AqiBand } | null;
      smogTrapped?: boolean;
    }
  | { type: 'reports'; reports: LiveReport[]; now?: number }
  | { type: 'modeTimes'; from: LonLat; to: LonLat; when: string; profile: Profile }
  | { type: 'whereis'; at: LonLat; when?: string; profile?: Profile }
  | { type: 'safetyLines'; bbox: number[]; when: string; profile: Profile; limit?: number }
  | { type: 'airLines'; bbox: number[]; limit?: number }
  | { type: 'open'; when: string }
  | {
      type: 'nearby';
      at: LonLat;
      when: string;
      cats: PoiCat[];
      radiusM: number;
      sort?: 'dist' | 'open';
      limit?: number;
    };
