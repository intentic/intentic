/* Gmail's list endpoints hand back ids and nothing else, so every listing is one request plus one per result.
 * Serially that is a two-second `gw mail search`; unbounded it is a burst Google rate-limits and then a
 * listing that fails for having been too eager. A small fixed window is the whole answer. */
export const mapLimit = async <T, R>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> => {
    const results: R[] = Array.from({ length: items.length });
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length) {
                return;
            }
            results[index] = await run(items[index] as T, index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
};
