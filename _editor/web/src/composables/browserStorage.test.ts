import { afterEach, expect, test, vi } from "vitest";
import { removeStoredValue, storedKeys, storedValue, storeValue } from "./browserStorage";

afterEach(() => vi.unstubAllGlobals());

test("blocked browser storage makes every operation a safe no-op", () => {
    vi.stubGlobal(`localStorage`, {
        get length(): number {
            throw new Error(`blocked`);
        },
        getItem: () => {
            throw new Error(`blocked`);
        },
        setItem: () => {
            throw new Error(`blocked`);
        },
        removeItem: () => {
            throw new Error(`blocked`);
        },
        key: () => {
            throw new Error(`blocked`);
        },
    });
    expect(storedValue(`key`)).toBeUndefined();
    expect(() => storeValue(`key`, `value`)).not.toThrow();
    expect(() => removeStoredValue(`key`)).not.toThrow();
    expect(storedKeys(`prefix`)).toEqual([]);
});
