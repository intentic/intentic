import { test, expect, afterEach } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { removeStoredValue, storedKeys, storedValue, storeValue } from "./browserStorage";

afterEach(() => unstubAllGlobals());

test("blocked browser storage makes every operation a safe no-op", () => {
    stubGlobal(`localStorage`, {
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
