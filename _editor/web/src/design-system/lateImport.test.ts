import { afterEach, describe, expect, it } from "bun:test";
import { lateImport, setLateImportFailure } from "@intentic/ui";

describe(`lateImport`, () => {
    afterEach(() => setLateImportFailure(() => undefined));

    it(`reports a failed load to the app's handler and still rejects for the caller's fallback`, async () => {
        const seen: unknown[] = [];
        setLateImportFailure((error) => seen.push(error));
        const failure = new TypeError(`Failed to fetch dynamically imported module: /deps/mermaid.js?v=stale`);
        await expect(lateImport(() => Promise.reject(failure))).rejects.toBe(failure);
        expect(seen).toEqual([failure]);
    });

    it(`passes a loaded module through without reporting`, async () => {
        const seen: unknown[] = [];
        setLateImportFailure((error) => seen.push(error));
        expect(await lateImport(() => Promise.resolve(42))).toBe(42);
        expect(seen).toEqual([]);
    });
});
