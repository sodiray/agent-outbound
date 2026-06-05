# Plan: Map View for the `view` UI

## Goal

Add a `/map` route to the Agent Outbound viz UI (`mission view <list>`) that plots every located, non-dropped lead on a Google Map. Pins are colored by fit score (green→yellow→orange→red). A fixed left panel — overlaid on a full-bleed map — lists leads compactly, drills into a single-lead detail, and morphs into filter/sort forms. The panel collapses to a header to maximize map real estate.

This is a frontend-heavy feature in the existing Vite/React app (`src/viz/ui`), plus a one-line server change to expose the Google Maps API key and (optionally) lat/lng to the client.

---

## Executive decisions & assumptions

These are decided. Codex should implement them as written unless it hits a hard blocker, in which case it stops and reports.

1. **Map library: `@vis.gl/react-google-maps`** (Google's official React wrapper). It handles script loading (`<APIProvider>`), gives us `<Map>`, `useMap()`, and a legacy `<Marker>` that accepts an `icon` prop. We render pins as **`google.maps.Marker` with a `SymbolPath.CIRCLE` icon** (fillColor by score, `strokeColor:'#fff'`, `strokeWeight:2`). The circle-symbol marker is the exact "basic circle dot with white border" the spec asks for, and — unlike `AdvancedMarker` — it requires **no Map ID / cloud-styled map**, so setup is zero-config beyond the API key. Do **not** use `AdvancedMarker` (needs a Map ID) for v1.

2. **Routing: add `react-router-dom`.** The spec explicitly wants a real URL (`/map`). Wrap the app in `<BrowserRouter>`; `/` = existing table, `/map` = new map view. The view server already falls back to `index.html` for any non-`/api` path (`src/viz/server.ts:122–129`), so deep-linking and refresh on `/map` work without further server changes.

3. **API key delivery: extend `/api/meta`.** Add `mapsApiKey: getEnv('GOOGLE_MAPS_API_KEY')` to the meta response. The frontend already fetches `/api/meta` on mount; the map route reads the key from there. (Decision: reuse `/api/meta` rather than add `/api/config` — one fewer endpoint, and meta is already the "boot config" payload.) If the key is empty, the map route renders a clear "Google Maps API key not configured" empty state instead of a broken map.

4. **Center/zoom on load: use `map.fitBounds(bounds, padding)`.** This is Google's recommended, battle-tested way to compute "the center of all pins + the closest integer zoom that still shows every pin." It does exactly the mercator math the spec describes, internally. We do **not** hand-roll the zoom formula for v1 (the manual formula is documented in Appendix A as the fallback/explanation only). Padding: ~64px all sides, with extra left padding equal to the expanded panel width (~360px) so pins aren't hidden under the panel. Single located lead → `setCenter` + zoom 13. Zero located leads → a sensible default center (continental US) at a low zoom, with an empty-state note.

5. **Click-to-focus keeps current zoom.** Clicking a lead (in the list or a map pin) calls `map.panTo({lat,lng})` and never changes the zoom — the user owns the zoom level. (Spec requirement, explicit.)

6. **Color scale (score → hue), HSL interpolation.** `priority_rank` is 0–100. `hue = priority_rank * 1.2` → 0 = red (hue 0), 50 = yellow (hue 60), 100 = green (hue 120), passing through orange. Use `hsl(hue, 75%, 48%)`. This gives the green→yellow→orange→red ramp the spec wants with one cheap formula. A lead with a score but no located point still shows its colored score chip in the list; it just has no pin.

7. **"Not dropped" is enforced two ways:** the map route always sends `filter.disqualified=qualified` (server-side, `src/viz/data.ts:493`) AND the client filters defensively. Dropped leads never appear in the list or on the map.

8. **No-location leads:** shown in the list in a **grayed-out** state (muted text, no score-color emphasis), sorted to the bottom of their group, with **no pin**. "Located" = `latitude` and `longitude` are present, numeric, and not `0,0`.

9. **Selected-lead focus state:** when viewing one lead's detail, every *other* pin desaturates to **light gray** (`#cfd3dc` fill, same white border) while the selected pin keeps its score color. Pins are not removed — only recolored. (Spec requirement, explicit.)

10. **Filters/sorts available in the map view** = the same set the table exposes (`meta.filters`, `sortableColumns(meta)`), **minus** any whose semantics only make sense with dropped/disabled rows. Concretely: drop the `disqualified` (Status) filter and the synthetic `state` lifecycle sort from the map's options, since the map is always "qualified, in-play." Everything else (city, state[geographic], vertical, `priority_rank` range, `user_rating_count` range, free-text search, score/created sorts) carries over unchanged, using the **same `ActiveFilter` model and the same `/api/records` query-param builder** in `src/viz/ui/src/api.ts`.

11. **Panel forms, not popovers.** In the table view, filter/sort are popovers (`FilterBuilder` ~`App.tsx:347`, `SortControl` ~`App.tsx:457`). In the map view they are **panel modes** with an **OK** button at the bottom that applies and returns to the list. We will **not** refactor the table's popovers; instead we extract the filter/sort *form bodies* into shared presentational components (see Phase 3) so both surfaces render the same controls. Lower risk to the working table view.

12. **Scope of change:** all UI work lands in `src/viz/ui/` (new components + `styles.css` + `package.json` deps + router). Backend change is limited to adding `mapsApiKey` (and confirming `latitude`/`longitude` ship in `/api/records` rows — they should already, as real columns). No DB/schema/pipeline changes.

---

## Architecture recap (grounding)

- **UI app:** `src/viz/ui/` — Vite 5 + React 18, single-file global CSS (`src/styles.css`, CSS custom props in `:root`), no CSS modules, no router today. Entry: `src/main.tsx` → `App.tsx` (one big stateful SPA).
- **Server:** `src/viz/server.ts` (Hono). Endpoints: `/api/meta`, `/api/records`, `/api/records/:rowId`, `/api/progress`, `/api/stream` (SSE), static fallback to `index.html`.
- **Data:** `src/viz/data.ts` — `buildMeta` (columns/filters/counts), `queryRecords` (filter/sort/search), `getRecordDetail` (full record + timeline + score + overrides).
- **Record shape (frontend):** flat dict (`RecordRow`) with `business_name`, `name`, `address`/`city`/`state`/`zip`, `latitude`, `longitude` (REAL), `priority_rank` (0–100 score), `google_place_id`, plus synthetic `__outcome`/`__stage`/`__dropped_at`.
- **Dropped detection:** `disqualified_at` / `disqualified_gate` / `disqualify_reason` non-empty, or `__stage==='dropped'`. Server filter `filter.disqualified=qualified` excludes them.
- **Key:** `GOOGLE_MAPS_API_KEY` lives in `~/.agent-outbound/env`, read via `getEnv()` (`src/orchestrator/runtime/env.ts:36`).

---

## UI structure

```
/map  (MapRoute)
└─ APIProvider(apiKey=meta.mapsApiKey)
   ├─ <Map>  (full-bleed, fills viewport under the panel)
   │   └─ N × <Marker icon=circle(scoreColor|gray)>  onClick→selectLead
   └─ <MapPanel>  (position:absolute; top/left; over the map)
       ├─ PanelHeader: [chevron collapse] {list.name} [filter icon] [sort icon]
       └─ PanelBody (mode machine):
           ├─ 'list'   → <LeadList>   (compact: score chip · name · location; gray if unlocated)
           ├─ 'detail' → <LeadDetail> (reuse data from /api/records/:rowId)
           ├─ 'filter' → <FilterForm> + [OK]
           └─ 'sort'   → <SortForm>   + [OK]
```

Panel **mode** state machine: `list ⇄ detail` (click lead / back), `list → filter|sort` (icons) `→ list` (OK). Collapsed flag is orthogonal (when collapsed, only PanelHeader shows; body hidden).

Selection drives both the panel (`detail` mode) and the map (pan + recolor others to gray). Clicking a pin sets the same selection → panel jumps to `detail`.

---

## Implementation phases (for Codex — build & validate one at a time)

> Per project rules: dispatch each phase to **Codex**, validate the diff before moving on. Run/build under **Node 24**. Don't hand Codex the whole plan — give it one phase at a time with the relevant excerpts. Validate by building the UI (`npm run build` in `src/viz/ui`) and loading `mission view <list>` in Chrome.

### Phase 0 — Server: expose the key (tiny, do first)
- In `src/viz/data.ts` `buildMeta`, add `mapsApiKey: getEnv('GOOGLE_MAPS_API_KEY')` to the returned object (import `getEnv`).
- Confirm `/api/records` rows already include `latitude`/`longitude` (they're real columns → they do; verify in the JSON).
- **Validate:** `curl localhost:<port>/api/meta` shows `mapsApiKey` populated; a record row has numeric lat/lng.

### Phase 1 — Router + route skeleton
- Add `react-router-dom` and `@vis.gl/react-google-maps` to `src/viz/ui/package.json`; `npm install` (Node 24).
- Wrap `<App/>` in `<BrowserRouter>` in `main.tsx`. Move the current single-page body into a `TableRoute` and mount `<Routes>`: `/`→TableRoute, `/map`→MapRoute (stub).
- Add a small nav affordance (Map / Table toggle) in the existing topbar so both are reachable.
- **Validate:** `/` still renders the table unchanged; `/map` renders the stub; refresh on `/map` works (server fallback).

### Phase 2 — Map + pins (read-only)
- MapRoute fetches `/api/meta` (key + filters) and `/api/records?filter.disqualified=qualified&limit=...`.
- Render `<APIProvider>` + `<Map>` full-bleed. Plot located leads as circle-symbol `<Marker>`s colored by `scoreColor(priority_rank)`; white border.
- On load, `fitBounds` over all located pins (padding incl. left panel width). Single/zero-pin fallbacks per Decision 4.
- **Validate (frugal):** load a list that already has lat/lng (e.g. meridian) in Chrome; confirm pins appear, colors ramp by score, the initial view frames all pins. No LLM/credit spend — this is pure read of existing data.

### Phase 3 — Left panel: list + detail + collapse
- Build `<MapPanel>` overlay with the header (chevron + list name + filter/sort icons) and the `list` mode: compact rows (score chip · name · `city, state`), grayed when unlocated.
- Click a row → `detail` mode for that lead (fetch `/api/records/:rowId`, reuse the table's detail rendering where practical) + `map.panTo` (keep zoom) + recolor other pins gray. Back button → `list`.
- Clicking a map pin → same selection path.
- Chevron collapses/expands the panel (body hidden when collapsed).
- Extract filter/sort **form bodies** from `FilterBuilder`/`SortControl` into shared presentational components used by Phase 4 (leave the table's popovers working by having them render the extracted bodies).
- **Validate:** click leads from list and from map; verify pan-without-zoom, gray-out of others, back navigation, collapse. Unlocated leads are gray and pin-less.

### Phase 4 — Filter & sort panel modes
- Filter icon → `filter` mode renders `<FilterForm>` (shared body) over `meta.filters` minus `disqualified`; OK applies → refetch → `list`.
- Sort icon → `sort` mode renders `<SortForm>` over `sortableColumns(meta)` minus synthetic `state`; OK applies → refetch → `list`.
- Re-fetch always keeps the forced `filter.disqualified=qualified`. After refetch, re-run `fitBounds` (or keep current view — decision: keep current view on filter/sort change so the user doesn't lose their zoom; only auto-fit on first load. Add a small "fit to results" button in the panel header for explicit re-framing).
- **Validate:** apply a city/state/score-range filter and a score sort; confirm list + pins update, dropped never appear, current zoom is preserved, "fit to results" reframes.

### Phase 5 — Polish & styling pass
- Match the topbar style (`.topbar*` classes, CSS vars) for the panel header. Add `.map-*` classes to `styles.css`.
- Empty states: no key, no located leads, no results after filter.
- Legend (optional, small): the color ramp with score endpoints.
- **Validate:** visual review in Chrome; confirm full-width map, panel overlay, transitions, dark theme consistency. Build is clean (`npm run build`, tsc green).

---

## Color & geometry reference

- **scoreColor(rank):** `const h = Math.max(0, Math.min(100, Number(rank) || 0)) * 1.2; return \`hsl(${h}, 75%, 48%)\`;`
- **gray (deselected focus):** fill `#cfd3dc`, stroke `#fff`.
- **Marker icon:** `{ path: google.maps.SymbolPath.CIRCLE, fillColor, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale: 7 }`.
- **isLocated(r):** `Number.isFinite(+r.latitude) && Number.isFinite(+r.longitude) && !(+r.latitude === 0 && +r.longitude === 0)`.

---

## Risks / watch-items

- **API key exposure:** the key ships to the browser (unavoidable for Maps JS). Note for the user: restrict the `GOOGLE_MAPS_API_KEY` to the Maps JavaScript API + HTTP referrers in the Google Cloud console. The `view` server is local-only by default, so risk is low, but flag it.
- **Marker deprecation:** `google.maps.Marker` is deprecated in favor of `AdvancedMarkerElement` (still fully functional). We accept legacy `Marker` for v1 to avoid the Map ID requirement; a later migration to `AdvancedMarker` (custom HTML pins) is a clean follow-up.
- **Detail rendering reuse:** the table's `DetailPanel` is coupled to the drawer. If reuse is messy, build a lean map-specific detail from the same `/api/records/:rowId` payload rather than forcing reuse.
- **fitBounds + panel overlap:** must pad bounds on the left by the panel width or pins hide under the panel. Decision 4 covers this.
- **Large lists:** hundreds of `Marker`s are fine; if a list ever has thousands, consider marker clustering (`@googlemaps/markerclusterer`) as a follow-up. Out of scope for v1.

---

## Appendix A — Manual zoom math (fallback / what `fitBounds` does internally)

If we ever need to compute zoom without `fitBounds` (e.g., to set a precise zoom programmatically), the canonical mercator approach:

```
WORLD_PX = 256, ZOOM_MAX = 21
latRad(lat) = ln( tan(π/4 + (lat·π/180)/2) )           // mercator y
zoom(mapPx, worldPx, fraction) = floor( log2( mapPx / worldPx / fraction ) )

// fraction for lat = (latRad(north) - latRad(south)) / (2π)
// fraction for lng = (east - west) / 360   (wrap if < 0: +360)
zoom = min( zoom(height, 256, latFraction), zoom(width, 256, lngFraction), ZOOM_MAX )
center = ( (north+south)/2 , (east+west)/2 )   // lng with antimeridian handling
```

`map.fitBounds(bounds, padding)` performs the equivalent and clamps to integer zoom, which is why it's the chosen approach.

Sources:
- [Map and Tile Coordinates — Google Maps JS API](https://developers.google.com/maps/documentation/javascript/coordinates)
- [Maps JavaScript API Reference (Map.fitBounds)](https://developers.google.com/maps/documentation/javascript/reference/map)
- [Zoom-to-fit all markers (mercator formula)](https://salman-w.blogspot.com/2011/03/zoom-to-fit-all-markers-on-google-map.html)

---

## Out of scope (v1)

- AdvancedMarker / custom HTML pins / Map IDs.
- Marker clustering.
- Editing leads from the map.
- Persisting map view state (zoom/center) across sessions.
- Heatmaps or polygons.
