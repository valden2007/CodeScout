export async function asyncPool<T, R>(limit: number, items: readonly T[], worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
