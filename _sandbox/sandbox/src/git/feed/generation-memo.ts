import { checkoutGeneration } from "./checkout-feed.js";

interface Kept<T> {
    readonly stamp: string;
    readonly at: number;
    readonly reading: Promise<T>;
}

// Completed readings can be reused only while ALL their inputs still match. Unknown generations always read fresh;
// age bounds missed events and the entry ceiling prevents a fleet of old conversations retaining every review.
export const generationMemo = <T>(options: { readonly maxAgeMs: number; readonly maxEntries?: number; readonly cacheable?: (value: T) => boolean }) => {
    const kept = new Map<string, Kept<T>>();
    return async (key: string, dirs: readonly string[], metadata: string, read: () => Promise<T>): Promise<T> => {
        const generations = await Promise.all(dirs.map(checkoutGeneration));
        if (generations.length === 0 || generations.some((value) => value === undefined)) {
            kept.delete(key);
            return read();
        }
        const stamp = JSON.stringify([dirs, generations, metadata]);
        const hit = kept.get(key);
        if (hit !== undefined && hit.stamp === stamp && Date.now() - hit.at < options.maxAgeMs) {
            kept.delete(key);
            kept.set(key, hit);
            return structuredClone(await hit.reading);
        }
        const reading = read();
        kept.delete(key);
        kept.set(key, { stamp, at: Date.now(), reading });
        for (const [oldest] of kept) {
            if (kept.size <= (options.maxEntries ?? 64)) {break;}
            kept.delete(oldest);
        }
        const forget = (): void => { if (kept.get(key)?.reading === reading) {kept.delete(key);} };
        void reading.then((value) => { if (options.cacheable?.(value) === false) {forget();} }, forget);
        return structuredClone(await reading);
    };
};
