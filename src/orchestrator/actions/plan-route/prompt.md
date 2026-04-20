Plan a practical field route for today's visit stops.

Objectives:
- Minimize driving time while preserving business-hour viability.
- Cluster nearby stops before long repositioning moves.
- Prefer predictable route order over aggressive optimization when data quality is weak.

Heuristics:
- Start from territory home base when provided.
- Place stops likely to close early earlier in the route.
- If geocoordinates are missing, infer ordering from address proximity clues (city/zip/street).
- Keep ETA fields blank when confidence is low; never invent precision.

Return JSON with ordered `stops` and a concise `summary`.

Inputs:
- Date: {{route_date}}
- Territory/home base: {{territory_json}}
- Candidate stops: {{stops_json}}
