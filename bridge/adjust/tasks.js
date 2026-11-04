const DAY_MS = 86_400_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const shiftDay = (day, offset) => new Date(Date.parse(day) + offset * DAY_MS).toISOString().slice(0, 10);

export const today = () => new Date().toISOString().slice(0, 10);

/** Inclusive list of YYYY-MM-DD days between from and to */
export function days(from, to) {
  const count = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  return Array.from({ length: Math.max(count, 0) }, (_, i) => shiftDay(from, i));
}

/** Maps items with at most `limit` promises in flight, preserving order */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
