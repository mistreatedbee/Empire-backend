export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function parseCoord(value: unknown): number | null {
  if (value == null) return null;
  const n = parseFloat(String(value));
  if (!Number.isFinite(n)) return null;
  if (n === 0 && value !== 0 && value !== '0') return null;
  return n;
}

export function isValidCoord(lat: number | null, lng: number | null): boolean {
  if (lat == null || lng == null) return false;
  if (lat === 0 && lng === 0) return false;
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function distanceKmBetween(
  fromLat: unknown,
  fromLng: unknown,
  toLat: unknown,
  toLng: unknown,
): number | null {
  const lat1 = parseCoord(fromLat);
  const lng1 = parseCoord(fromLng);
  const lat2 = parseCoord(toLat);
  const lng2 = parseCoord(toLng);
  if (!isValidCoord(lat1, lng1) || !isValidCoord(lat2, lng2)) return null;
  return Math.round(haversineKm(lat1!, lng1!, lat2!, lng2!) * 10) / 10;
}
