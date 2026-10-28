import { assignTerritories } from '../territories/assign.js';
import {
  circleIntersectsPolygon,
  GEO_SUBDIVISION_RADIUS_FACTOR,
  metersToLat,
  metersToLng,
  pointInPolygon,
  polygonBbox,
  subdivisionChildCenters,
  type GeoPoint,
} from '../lib/geo.js';
import { readConfig } from '../lib/config.js';
import { makeRecordId } from '../lib/record.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { normalizeExcludeRules } from '../lib/source-exclude.js';
import { getMcpClient } from '../runtime/mcp.js';
import { logSourcingEvent, openListDb } from '../runtime/db.js';
import { emitActivity } from '../runtime/activity.js';
import { createDedupRunState, getIdentityFields } from './dedup.js';
import {
  dedupRowsByKey,
  loadExistingDedupValues,
  mapStrategyRow,
  nearbySearch,
  normalizeDedupKey,
  processAndInsertRows,
} from './runner.js';

const finiteNumber = (value: any) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isQuotaError = (error: any) => {
  const message = String((error as any)?.message || error);
  return message.includes('429') || message.includes('RESOURCE_EXHAUSTED');
};

const createSemaphore = (limit: number) => {
  const state = {
    active: 0,
    queue: [] as Array<() => void>,
  };
  const acquire = () => new Promise<() => void>((resolve) => {
    const start = () => {
      const release = () => {
        state.active = Math.max(0, state.active - 1);
        const next = state.queue.shift();
        if (next) next();
      };
      state.active += 1;
      resolve(release);
    };
    if (state.active < limit) {
      start();
      return;
    }
    state.queue.push(start);
  });
  return { acquire };
};

const createCallStartSpacer = (spacingMs: number) => {
  const state = {
    lastStart: 0,
    chain: Promise.resolve(),
  };
  const wait = () => {
    const next = state.chain.then(async () => {
      const delay = Math.max(0, spacingMs - (Date.now() - state.lastStart));
      if (delay > 0) await sleep(delay);
      state.lastStart = Date.now();
    });
    state.chain = next.catch(() => {});
    return next;
  };
  return { wait };
};

const FALLBACK_TOOL = {
  server: 'googlemaps',
  tools: ['MAPS_NEARBY_SEARCH'],
};

const FALLBACK_OUTPUT_MAP = {
  business_name: 'name',
  website: 'website',
  phone: 'phone',
  address: 'address',
  place_id: 'placeId',
  latitude: 'location.lat',
  longitude: 'location.lng',
  primary_type: 'primaryType',
  business_status: 'businessStatus',
  user_rating_count: 'userRatingCount',
};

const MINIMAL_NON_BUSINESS_EXCLUDED_TYPES = [
  'parking',
  'parking_lot',
  'atm',
  'bus_stop',
  'transit_station',
  'train_station',
  'subway_station',
  'light_rail_station',
  'public_bathroom',
  'rest_stop',
];

const COMMERCIAL_TYPES = [
  'accounting',
  'bakery',
  'bank',
  'bar',
  'beauty_salon',
  'bicycle_store',
  'book_store',
  'bowling_alley',
  'cafe',
  'car_dealer',
  'car_rental',
  'car_repair',
  'car_wash',
  'clothing_store',
  'convenience_store',
  'dentist',
  'department_store',
  'doctor',
  'electrician',
  'electronics_store',
  'florist',
  'furniture_store',
  'gym',
  'hair_care',
  'hardware_store',
  'home_goods_store',
  'insurance_agency',
  'jewelry_store',
  'laundry',
  'lawyer',
  'liquor_store',
  'locksmith',
  'meal_delivery',
  'meal_takeaway',
  'moving_company',
  'night_club',
  'painter',
  'pet_store',
  'pharmacy',
  'physiotherapist',
  'plumber',
  'real_estate_agency',
  'restaurant',
  'roofing_contractor',
  'shoe_store',
  'shopping_mall',
  'spa',
  'storage',
  'supermarket',
  'travel_agency',
  'veterinary_care',
];

const sourceConfigFor = (config: any) => {
  const strategy = (Array.isArray(config?.source?.strategies) ? config.source.strategies : [])
    .find((item: any) => String(item?.kind || '') === 'geo_tiles');
  return {
    outputMap: strategy?.output_map || FALLBACK_OUTPUT_MAP,
    tool: strategy?.tool || FALLBACK_TOOL,
    excludedTypes: MINIMAL_NON_BUSINESS_EXCLUDED_TYPES,
  };
};

const range = (start: number, end: number, step: number) => {
  if (![start, end, step].every(Number.isFinite) || step <= 0) return [];
  const count = Math.max(1, Math.floor((end - start) / step) + 1);
  return Array.from({ length: count + 1 }, (_, index) => start + index * step)
    .filter((value) => value <= end + step / 2);
};

const buildSeedCircles = ({ ring, r0 }: { ring: GeoPoint[]; r0: number }) => {
  const bbox = polygonBbox(ring);
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const latStep = metersToLat(r0);
  const lngStep = metersToLng(r0, midLat);
  const lats = range(bbox.minLat, bbox.maxLat, latStep);
  const lngs = range(bbox.minLng, bbox.maxLng, lngStep);
  const circles = lats.flatMap((lat) => lngs.map((lng) => ({ center: { lat, lng }, radiusM: r0 })))
    .filter((circle) => circleIntersectsPolygon(circle.center, circle.radiusM, ring));
  return {
    bbox,
    step: { lat: latStep, lng: lngStep },
    circles,
  };
};

const mappedLocatedPoint = (row: any) => {
  const lat = finiteNumber(row.latitude ?? row.lat);
  const lng = finiteNumber(row.longitude ?? row.lng);
  return lat === null || lng === null ? null : { lat, lng };
};

const withIds = (rows: any[]) => rows.map((row) => {
  const id = row._row_id || row.id || row.place_id || row.google_place_id || makeRecordId(row);
  return { ...row, _row_id: id, id };
});

const nearbyParams = ({ sourceConfig, center, radiusM, types = [] }: { sourceConfig: any; center: GeoPoint; radiusM: number; types?: string[] }) => ({
  tool: sourceConfig.tool,
  lat: center.lat,
  lng: center.lng,
  radius_m: radiusM,
  rank: 'distance',
  types,
  excluded_types: types.length > 0 ? [] : sourceConfig.excludedTypes,
  output_map: sourceConfig.outputMap,
  max_results: 20,
});

const dryRunSummary = ({ listDir, territory, r0, floor, maxCalls, concurrency, seedPlan }: any) => ({
  dry_run: true,
  list: listDir,
  territory: {
    id: String(territory.id || ''),
    name: String(territory.name || ''),
  },
  bbox: seedPlan.bbox,
  seed_circles: seedPlan.circles.length,
  r0_m: r0,
  floor_m: floor,
  max_calls: maxCalls,
  concurrency,
  estimated_initial_api_calls: seedPlan.circles.length,
  circles: seedPlan.circles.map((circle: any) => ({
    lat: circle.center.lat,
    lng: circle.center.lng,
    radius_m: circle.radiusM,
  })),
});

export const sourceTerritory = async ({ listDir, territoryId, opts = {} }: { listDir: string; territoryId: string; opts?: any }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'source' });

  const territory = (Array.isArray(config?.territories) ? config.territories : [])
    .find((item: any) => String(item?.id || '') === String(territoryId || ''));
  if (!territory) throw new Error(`Territory not found: ${territoryId}`);

  const r0 = Math.max(1, Number(opts?.r0 || 350));
  const floor = Math.max(1, Number(opts?.floor || 60));
  const maxCalls = Math.max(0, Number(opts?.maxCalls ?? opts?.max_calls ?? 400));
  const concurrency = Math.max(1, Number(opts?.concurrency || 5));
  const dryRun = Boolean(opts?.dryRun || opts?.dry_run);
  const ring = Array.isArray(territory?.polygon) ? territory.polygon : [];
  const seedPlan = buildSeedCircles({ ring, r0 });

  if (dryRun) return dryRunSummary({ listDir, territory, r0, floor, maxCalls, concurrency, seedPlan });

  const sourceConfig = sourceConfigFor(config);
  const db = openListDb({ listDir, readonly: false });
  const mcp = await getMcpClient();
  const toolCatalog = readToolCatalog(listDir);
  const identityFields = getIdentityFields(config);
  const excludeRules = normalizeExcludeRules(config?.source?.exclude);
  const dedupKey = normalizeDedupKey(config?.source?.dedup_key || 'place_id');
  const dedupConfig = {
    dedupKey,
    aiDedup: config?.source?.ai_dedup,
    maxCandidates: Number(config?.source?.ai_dedup_max_candidates || 3),
    fields: config?.source?.ai_dedup_fields,
    maxCharsPerField: config?.source?.ai_dedup_max_chars_per_field,
    context: config?.source?.ai_dedup_context,
  };
  const dedupRunState = createDedupRunState({
    maxCalls: Number(config?.source?.ai_dedup_max_calls ?? 100),
  });
  const nearDuplicate = config?.source?.near_duplicate || {};
  const state = {
    calls: 0,
    retries: 0,
    circlesRun: 0,
    saturatedCircles: 0,
    typeSegmentCalls: 0,
    capHit: false,
    errors: 0,
    errorSamples: [] as string[],
  };
  const semaphore = createSemaphore(concurrency);
  const callStartSpacer = createCallStartSpacer(120);

  const recordNearbyError = (error: any) => {
    state.errors += 1;
    if (state.errorSamples.length < 5) {
      state.errorSamples.push(String((error as any)?.message || error));
    }
  };

  const callNearbyOnce = async ({ params, taskId }: { params: any; taskId: string }) => {
    const release = await semaphore.acquire();
    try {
      await callStartSpacer.wait();
      if (state.calls >= maxCalls) {
        state.capHit = true;
        return null;
      }
      state.calls += 1;
      return nearbySearch({
        mcp,
        listDir,
        toolCatalog,
        params,
        taskId,
      });
    } finally {
      release();
    }
  };

  const runNearby = async ({ center, radiusM, types = [] }: { center: GeoPoint; radiusM: number; types?: string[] }) => {
    if (state.calls >= maxCalls) {
      state.capHit = true;
      return [];
    }
    const params = nearbyParams({ sourceConfig, center, radiusM, types });
    const taskId = `territory:${String(territory.id || '')}`;
    const attempt = async (attemptIndex: number): Promise<any[]> => {
      try {
        const result = await callNearbyOnce({ params, taskId });
        if (!result) return [];
        return (Array.isArray(result.rows) ? result.rows : []).map((row: any) => mapStrategyRow({ row, outputMap: sourceConfig.outputMap }));
      } catch (error) {
        if (isQuotaError(error) && attemptIndex < 3 && !state.capHit) {
          state.retries += 1;
          await sleep(1000 * (2 ** attemptIndex));
          return attempt(attemptIndex + 1);
        }
        recordNearbyError(error);
        return [];
      }
    };
    return attempt(0);
  };

  const harvest = async ({ center, radiusM }: { center: GeoPoint; radiusM: number }): Promise<any[]> => {
    if (state.capHit) return [];
    state.circlesRun += 1;
    const rows = await runNearby({ center, radiusM });
    if (rows.length < 20) return rows;
    state.saturatedCircles += 1;
    if (radiusM > floor) {
      // For the child matching a point's quadrant, d² <= R²/2; 0.71R is greater
      // than R/√2, so the four child circles cover the entire parent disc.
      const childRows = await Promise.all(subdivisionChildCenters({ center, radiusM })
        .map((child) => harvest({ center: child, radiusM: radiusM * GEO_SUBDIVISION_RADIUS_FACTOR })));
      return childRows.flat();
    }
    const typeRows = await COMMERCIAL_TYPES.reduce(async (promise, type) => {
      const acc = await promise;
      if (state.capHit) return acc;
      state.typeSegmentCalls += 1;
      const nextRows = await runNearby({ center, radiusM, types: [type] });
      return [...acc, ...nextRows];
    }, Promise.resolve([] as any[]));
    return [...rows, ...typeRows];
  };

  try {
    emitActivity({ event: 'phase_start', phase: 'source_territory', territory_id: String(territory.id || ''), seed_circles: seedPlan.circles.length });
    const harvestedRows = await seedPlan.circles.reduce(async (promise, circle) => {
      const acc = await promise;
      if (state.capHit) return acc;
      const rows = await harvest({ center: circle.center, radiusM: circle.radiusM });
      return [...acc, ...rows];
    }, Promise.resolve([] as any[]));
    const seen = loadExistingDedupValues({ db, dedupKey });
    const deduped = dedupRowsByKey({ rows: harvestedRows, dedupKey, seen });
    const insideRows = withIds(deduped.unique.filter((row: any) => {
      const point = mappedLocatedPoint(row);
      return point ? pointInPolygon(point, ring) : false;
    }));
    const processed = await processAndInsertRows({
      db,
      rows: insideRows,
      identityFields,
      listName: config?.list?.name || 'list',
      listDir,
      aiConfig: config?.ai || {},
      dedupConfig,
      dedupRunState,
      excludeRules,
      nearDuplicate,
    });
    const territoryAssignment = assignTerritories({ listDir, config, db, rowIds: processed.insertedIds });
    const summary = {
      status: state.capHit ? 'capped' : 'ok',
      territory_id: String(territory.id || ''),
      circles_planned: seedPlan.circles.length,
      circles_run: state.circlesRun,
      saturated_circles: state.saturatedCircles,
      type_segment_calls: state.typeSegmentCalls,
      total_found: harvestedRows.length,
      inside_fence_kept: insideRows.length,
      inserted: processed.insertedIds.length,
      inserted_ids: processed.insertedIds,
      deduped: deduped.duplicates + processed.deduped,
      filtered_out: processed.filtered,
      excluded_by_rule: processed.excludedByRule,
      errors: state.errors,
      error_samples: state.errorSamples,
      insert_errors: processed.errors,
      est_api_calls: state.calls,
      retries: state.retries,
      concurrency,
      max_calls: maxCalls,
      max_calls_hit: state.capHit,
      territories: territoryAssignment,
    };
    logSourcingEvent({ listDir, payload: { ...summary, mode: 'territory' } });
    emitActivity({ event: 'phase_complete', phase: 'source_territory', territory_id: String(territory.id || ''), inserted: processed.insertedIds.length });
    return summary;
  } finally {
    db.close();
  }
};
