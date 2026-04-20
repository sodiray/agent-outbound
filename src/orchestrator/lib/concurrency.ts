export const mapWithConcurrency = async <T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 3,
): Promise<R[]> => {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const limit = Math.max(1, Number(concurrency || 1));
  const results = new Array<R>(list.length);
  let cursor = 0;

  const runWorker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) break;
      results[index] = await worker(list[index], index);
    }
  };

  const workers = Array.from({ length: Math.min(limit, list.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
};
