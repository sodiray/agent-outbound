# Territories — geo-fence feature + exhaustive territory sourcing

Status: in progress (delegated to Codex, validated by Claude). Repo: `agent-outbound`, branch `main` (commit directly, no branches).

## Goal
A **territory** is a named geo-fence polygon (lat/lng ring) defined in the list config. Leads fall into
territories automatically by point-in-polygon. The map UI draws each territory (shaded interior, darker
border), offers a floating top-right territories menu (toggle all / expand list / select one), and selecting
a territory filters the map+list to only the leads inside it and shows its outline. Plus: a new
**exhaustive sourcing** flow that pulls *every* business inside a territory (adaptive circle subdivision to
beat Google's 20-result Nearby cap).

End-state acceptance (what the user does tomorrow morning):
open the viz → see the "Downtown Boise" territory drawn → see all leads in it → filter the map to just
those leads → walk every one on foot.

## Naming caution
`src/schemas/config.ts` ALREADY has a `TerritorySchema` bound to `config.list.territory` (home-base /
drive-radius canvassing config) — a DIFFERENT concept. Do **not** touch it. The new feature is a top-level
`config.territories` array. Name the new zod schema `TerritoryAreaSchema` to avoid collision.

---

## Workstream A — data layer (config + DB + membership)

### A1. Config schema (`src/schemas/config.ts`)
Add, near the brief/automations schemas:
```ts
const TerritoryPointSchema = z.object({ lat: z.coerce.number(), lng: z.coerce.number() });
const TerritoryAreaSchema = z.object({
  id: z.string().min(1),                 // stable slug, e.g. "downtown-boise"
  name: z.string().min(1),
  description: z.string().default(''),
  // polygon ring as {lat,lng} objects (matches GeoTileSchema style). >=3 points.
  // Auto-closed at load (a trailing point equal to the first is allowed but not required).
  polygon: z.array(TerritoryPointSchema).min(3),
  color: z.string().default(''),         // optional hex override for the outline/fill
}).partial({ description: true, color: true });
```
Add to `ConfigSchema`: `territories: z.array(TerritoryAreaSchema).default([]),`.
In `normalizeConfig`, after parse, **auto-close each polygon**: if `first !== last`, append a copy of the
first point. Validate it's a *simple* (non-self-intersecting) ring; on failure push a WARNING (not a hard
error — keep it functional). Keep the ring in `config.territories`.

### A2. Geometry util (`src/orchestrator/lib/geo.ts`, new)
- `pointInPolygon(point: {lat,lng}, ring: {lat,lng}[]): boolean` — ray casting, lng=x, lat=y.
- `polygonBbox(ring): {minLat,maxLat,minLng,maxLng}`.
- `polygonCentroid(ring)`, `polygonAreaKm2(ring)` (shoelace w/ lat-cos correction).
- `circleIntersectsPolygon(center, radiusM, ring)` — bbox-grow test is fine (functional).
- Pure functions, unit-testable, no deps.

### A3. DB tables (`src/orchestrator/runtime/db.ts`)
Follow the existing `CREATE TABLE IF NOT EXISTS` + idempotent `ALTER TABLE` pattern. Add to the schema block:
```sql
CREATE TABLE IF NOT EXISTS lead_territories (
  row_id TEXT NOT NULL,
  territory_id TEXT NOT NULL,
  assigned_at TEXT DEFAULT '',
  PRIMARY KEY (row_id, territory_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_territories_territory ON lead_territories(territory_id);
CREATE TABLE IF NOT EXISTS territory_notes (
  note_id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  body TEXT DEFAULT '',
  created_at TEXT DEFAULT '',
  created_by TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_territory_notes_territory ON territory_notes(territory_id);
```
Export helpers (mirror existing helper style — `({ db, ... }) =>`):
- `setLeadTerritories({ db, rowId, territoryIds, at })` — replace all rows for rowId with the given set
  (delete-then-insert in a txn).
- `getTerritoryMembership({ db })` → `Map<territory_id, Set<row_id>>` or counts.
- `getTerritoriesForRow({ db, rowId })` → `string[]`.
- `insertTerritoryNote({ db, territoryId, body, createdBy })`, `getTerritoryNotes({ db, territoryId })`.

### A4. Membership assignment (`src/orchestrator/territories/assign.ts`, new)
- `assignTerritories({ listDir, config, db?, rowIds? })`: for each record with finite `latitude`/`longitude`
  (use those columns — that's what the map uses, see `map/colors.ts`), compute which `config.territories`
  polygons contain it via `pointInPolygon`, and `setLeadTerritories` for that row (a lead in N territories →
  N rows; 0 → cleared). If `rowIds` given, only reassign those; else all located records. Returns a summary
  `{ assigned: n, byTerritory: {id: count} }`.
- Call it at the END of `runSourcing` (after inserts) and at the end of the new territory-source flow.

### A5. CLI: `territories` command group (`src/commands/territories.ts`, new; wire in `index.ts` + `cli.ts`)
- `territories list <list>` — print each territory: id, name, #leads, #qualified, area.
- `territories assign <list>` — backfill: run `assignTerritories` over all records. Print summary.
- `territories note <list> <territoryId> --body "..." [--by NAME]` — add a CRM note.
- `territories show <list> <territoryId>` — print metadata, notes, and lead count.
Follow the existing command file/dispatch pattern (see `src/commands/automations.ts` + `cli.ts` automations block).

---

## Workstream B — exhaustive territory sourcing (`src/orchestrator/sourcing/territory.ts`, new)

Beat Google Nearby's hard 20-result cap via **adaptive circle subdivision**.

`sourceTerritory({ listDir, territoryId, opts })`:
1. Load config; find the territory by id (error if missing). Compute polygon bbox.
2. Build an initial set of seed circles covering the bbox (square grid step ≈ R0; keep circles whose center
   or coverage intersects the polygon via `circleIntersectsPolygon`). **R0 = 350m** default.
3. For each circle, **recurse** `harvest(center, radiusM)`:
   - Run a Google Nearby call (reuse `executeStrategyTask` by constructing a synthetic
     `{ kind:'geo_tiles', params:{ lat,lng,radius_m, rank:'distance', types:[], excluded_types: <from territory source cfg>, output_map: <see below>, tool: <googlemaps MAPS_NEARBY_SEARCH spec>, max_results:20 } }`
     task, OR factor a small `nearbySearch()` helper out of `executeStrategyTask`). Map rows with
     `mapStrategyRow({ row, outputMap })`.
   - If returned rows **< 20** → exhausted; collect rows, return.
   - If **== 20** (saturated) AND `radiusM > FLOOR (≈ 60m)` → split into 4 sub-circles
     (centers offset by ±radius/2 in lat/lng, child radius = radius * 0.6) and recurse each.
   - If **== 20** AND `radiusM <= FLOOR` (point-cluster) → **type-segment**: re-run the Nearby call once per
     type in a curated commercial type list (see below), each capped at 20, collect+dedup.
4. Dedup all harvested rows by `place_id` (use `dedupRowsByKey`), then **point-in-polygon filter**: keep only
   rows whose mapped lat/lng is inside the territory ring (drop businesses pulled from circle overflow that
   sit outside the fence).
5. Insert via `processAndInsertRows` (same path as normal sourcing → identical record shape, dedup, embeddings).
6. `assignTerritories({ ..., rowIds: insertedIds })` so the new leads get their membership rows.
7. Print a summary: circles run, businesses found, inside-fence kept, inserted, deduped, est. API calls.

Output_map + tool spec + excluded_types: reuse the list's existing `geo_tiles` strategy config from
`config.source.strategies` (find the one with `kind==='geo_tiles'`) for `output_map`, `tool`, and
`excluded_types`. If none, fall back to the same `output_map` the downtown list uses (name/website/phone/
address/placeId/location.lat/location.lng/primaryType/businessStatus/userRatingCount) and the googlemaps
MAPS_NEARBY_SEARCH tool spec.

Commercial type list (for the type-segment fallback) — Google Places Table-A commercial types minus our
blocklist (schools, lodging, gas_station, parks, worship, government, parking, cemetery). A ~50-entry list is
fine; put it in `territory.ts` as a const.

CLI: `source-territory <list> <territoryId> [--r0 350] [--floor 60] [--dry-run] [--max-calls N]`. On
`--dry-run`, compute+print the seed circle plan and bbox without calling the API. Add a `--max-calls` safety
cap (default e.g. 400) so a runaway recursion can't burn unbounded API spend; log if the cap is hit.

Wire into `cli.ts` + `commands/index.ts`.

---

## Workstream C — viz backend (`src/viz/data.ts`, `src/viz/server.ts`)

### C1. `buildMeta` (data.ts): add `territories` to the meta payload
```ts
territories: config.territories.map(t => ({
  id, name, description, color,
  polygon: [{lat,lng}...],            // the closed ring
  lead_count, qualified_count,        // from lead_territories joined to records
}))
```
Also add a `territory` filter to the meta `filters` list (type 'enum', options = territory ids) OR handle it
as a special query param (see C2).

### C2. `queryRecords` (data.ts): support a `territory` filter
When the request carries `filter.territory=<id>` (or a dedicated `territory` query param), constrain results
to `row_id IN (SELECT row_id FROM lead_territories WHERE territory_id = ?)`. Must compose with the existing
`disqualified=qualified` filter and others. Keep it injection-safe (parameterized).

### C3. server.ts: endpoints
- `GET /api/territories` → the territories array (same shape as meta.territories) — convenience for the panel.
- `GET /api/territories/:id/notes` → notes list.
- `POST /api/territories/:id/notes` (JSON `{ body, by }`) → insert note, return it.
Follow the existing Hono route + try/catch pattern.

---

## Workstream D — viz frontend (`src/viz/ui/src/`)

### D1. Types (`types.ts`)
```ts
export type Territory = {
  id: string; name: string; description: string; color: string;
  polygon: { lat: number; lng: number }[];
  lead_count: number; qualified_count: number;
};
```
Add `territories: Territory[]` to `MetaResponse`.

### D2. Map overlay (`MapRoute.tsx`)
`@vis.gl/react-google-maps` has NO `<Polygon>` component — draw imperatively. Add a `TerritoryShapes`
child of `<Map>` that uses `useMap()` and creates `new google.maps.Polygon({ paths, strokeColor,
strokeWeight:2, fillColor, fillOpacity:0.12 })` for each VISIBLE territory; set `map` on it; clean up
(`setMap(null)`) on change/unmount. Border darker, interior light shade. Selected territory = stronger
stroke/opacity. Respect `visibleTerritoryIds` from the panel.

### D3. Territories panel (top-right floating) — mirror `MapPanel` (`.map-panel`) on the right
New `TerritoriesPanel` floating top-right (new `.territories-panel` CSS mirroring `.map-panel` but
right-anchored). Collapsed = a header button ("Territories"); expanded = list of territories each with:
a visibility toggle (checkbox/eye), name, lead count, and a "Filter to this" / select action. A global
"toggle all" control. Selecting a territory:
- sets the records filter to that territory (adds `{ kind:'enum', key:'territory', value:id }` to filters so
  `fetchRecords` constrains to it), and
- highlights+fits that territory's outline.
Show description on expand; (notes UI optional — if cheap, a small notes list + add-note box per territory
using the notes endpoints; otherwise skip for now and just show description).

### D4. Filtering plumbing (`MapRoute.tsx`)
`fetchRecords` already takes `filters`. Add the territory filter into that path. When a territory is selected,
also call fit-to-bounds on that territory's polygon. Keep the existing `QUALIFIED_FILTER` behavior (territory
filter composes with it).

### D5. Build
`cd src/viz/ui && npm run build` must pass (tsc + vite). The server serves `ui/dist`.

---

## Validation (Claude)
1. `npx tsc --noEmit` (root) + `cd src/viz/ui && npm run build` green.
2. Unit-check `pointInPolygon` against the downtown ring (a known-inside and known-outside point).
3. Add the `downtown-boise` territory to `.outbound/treasure-valley/outbound.yaml` (coords below).
4. `territories list` shows it. `source-territory --dry-run` prints a sane circle plan.
5. Run the real pull → `pipeline` → `score` → `territories assign`.
6. Browser: territory draws, panel works, selecting filters the map.

## Downtown Boise territory (geocoded, validated simple ring, 3.66 km²)
```yaml
territories:
  - id: downtown-boise
    name: Downtown Boise
    description: Boise proper — Capitol, Ada County Courthouse, Idaho Central Arena and surrounds.
    polygon:
      - { lat: 43.631823, lng: -116.220986 }  # 26th & W Ellis
      - { lat: 43.626646, lng: -116.213344 }  # 20th & W Ellis
      - { lat: 43.626631, lng: -116.209041 }  # 17th & W Ellis
      - { lat: 43.626434, lng: -116.206873 }  # 16th & W Fort
      - { lat: 43.615737, lng: -116.192862 }  # 2nd & W Fort
      - { lat: 43.608990, lng: -116.199397 }  # Myrtle & S 2nd
      - { lat: 43.611969, lng: -116.205267 }  # Capitol & Myrtle
      - { lat: 43.606285, lng: -116.210865 }  # Capitol & Sherwood
      - { lat: 43.615118, lng: -116.222437 }  # Americana Terrace & Americana Blvd
```
(loader auto-closes the ring)
```
