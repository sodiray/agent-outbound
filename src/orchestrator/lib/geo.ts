export type GeoPoint = { lat: number; lng: number };
export type GeoBbox = { minLat: number; maxLat: number; minLng: number; maxLng: number };

const EARTH_RADIUS_M = 6371000;
const KM_PER_DEG_LAT = 110.574;
const isFinitePoint = (point: GeoPoint) => Number.isFinite(point.lat) && Number.isFinite(point.lng);
const usableRing = (ring: GeoPoint[]) => (Array.isArray(ring) ? ring.filter(isFinitePoint) : []);
const degToRad = (value: number) => value * Math.PI / 180;
const lngKmPerDegree = (lat: number) => 111.320 * Math.cos(degToRad(lat));

export const GEO_SUBDIVISION_RADIUS_FACTOR = 0.71;

export const metersToLat = (meters: number) => meters / 1000 / KM_PER_DEG_LAT;
export const metersToLng = (meters: number, lat: number) => meters / 1000 / (lngKmPerDegree(lat) || 111.320);

export const subdivisionChildCenters = ({ center, radiusM }: { center: GeoPoint; radiusM: number }) => {
  const latOffset = metersToLat(radiusM / 2);
  const lngOffset = metersToLng(radiusM / 2, center.lat);
  return [
    { lat: center.lat - latOffset, lng: center.lng - lngOffset },
    { lat: center.lat - latOffset, lng: center.lng + lngOffset },
    { lat: center.lat + latOffset, lng: center.lng - lngOffset },
    { lat: center.lat + latOffset, lng: center.lng + lngOffset },
  ];
};

const distanceM = (a: GeoPoint, b: GeoPoint) => {
  const dLat = degToRad(b.lat - a.lat);
  const dLng = degToRad(b.lng - a.lng);
  const lat1 = degToRad(a.lat);
  const lat2 = degToRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

export const polygonBbox = (ring: GeoPoint[]): GeoBbox => {
  const points = usableRing(ring);
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  };
};

export const pointInPolygon = (point: GeoPoint, ring: GeoPoint[]): boolean => {
  if (!isFinitePoint(point)) return false;
  const points = usableRing(ring);
  if (points.length < 3) return false;
  return points.reduce((inside, current, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const intersects = ((current.lat > point.lat) !== (previous.lat > point.lat))
      && (point.lng < (previous.lng - current.lng) * (point.lat - current.lat) / (previous.lat - current.lat) + current.lng);
    return intersects ? !inside : inside;
  }, false);
};

export const polygonCentroid = (ring: GeoPoint[]): GeoPoint => {
  const points = usableRing(ring);
  const open = points.length > 1 && points[0].lat === points[points.length - 1].lat && points[0].lng === points[points.length - 1].lng
    ? points.slice(0, -1)
    : points;
  if (open.length === 0) return { lat: 0, lng: 0 };
  const sum = open.reduce((acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / open.length, lng: sum.lng / open.length };
};

export const polygonAreaKm2 = (ring: GeoPoint[]): number => {
  const points = usableRing(ring);
  if (points.length < 3) return 0;
  const centroid = polygonCentroid(points);
  const kmPerDegLng = lngKmPerDegree(centroid.lat);
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    const x1 = point.lng * kmPerDegLng;
    const y1 = point.lat * KM_PER_DEG_LAT;
    const x2 = next.lng * kmPerDegLng;
    const y2 = next.lat * KM_PER_DEG_LAT;
    return sum + (x1 * y2 - x2 * y1);
  }, 0);
  return Math.abs(area) / 2;
};

export const circleIntersectsPolygon = (center: GeoPoint, radiusM: number, ring: GeoPoint[]): boolean => {
  if (!isFinitePoint(center) || !Number.isFinite(radiusM) || radiusM < 0) return false;
  const bbox = polygonBbox(ring);
  if (![bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng].every(Number.isFinite)) return false;
  const latGrow = metersToLat(radiusM);
  const lngGrow = metersToLng(radiusM, center.lat);
  const inGrownBbox = center.lat >= bbox.minLat - latGrow
    && center.lat <= bbox.maxLat + latGrow
    && center.lng >= bbox.minLng - lngGrow
    && center.lng <= bbox.maxLng + lngGrow;
  if (!inGrownBbox) return false;
  if (pointInPolygon(center, ring)) return true;
  return usableRing(ring).some((point) => distanceM(center, point) <= radiusM);
};
