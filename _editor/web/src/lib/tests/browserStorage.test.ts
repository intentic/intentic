import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { z } from "zod";
import {
    chatTabsKey,
    clearAccountStorage,
    deviceKey,
    isAccountKey,
    removeStoredValue,
    storedJson,
    storedKeys,
    storedValue,
    storeJson,
    storeValue,
} from "../browserStorage";
import { accountKeys, onAccountCleared } from "@intentic/ui/storage";

afterEach(() => {
    unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
});

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
    expect(storedJson(`key`, z.object({ a: z.number() }))).toBeUndefined();
    expect(() => storeJson(`key`, { a: 1 })).not.toThrow();
});

test("storage that names itself and then refuses to exist is the same no-op", () => {
    // Site data off: reading the global itself throws, before any method is reached.
    const held = Object.getOwnPropertyDescriptor(globalThis, `sessionStorage`);
    Object.defineProperty(globalThis, `sessionStorage`, {
        configurable: true,
        get: () => {
            throw new Error(`SecurityError`);
        },
    });
    try {
        expect(storedValue(`key`, `session`)).toBeUndefined();
        expect(() => storeValue(`key`, `value`, `session`)).not.toThrow();
        expect(storedKeys(``, `session`)).toEqual([]);
    } finally {
        // The DOM preload's own storage comes back for every later test.
        if (held !== undefined) {
            Object.defineProperty(globalThis, `sessionStorage`, held);
        }
    }
});

test("a full quota keeps nothing, and the next read is whatever was there", () => {
    storeValue(`draft`, `kept`);
    stubGlobal(`localStorage`, {
        getItem: () => `kept`,
        setItem: () => {
            throw new DOMException(`over`, `QuotaExceededError`);
        },
    });
    expect(() => storeValue(`draft`, `longer`)).not.toThrow();
    expect(storedValue(`draft`)).toBe(`kept`);
});

describe("a JSON value read through its schema", () => {
    const Draft = z.object({ message: z.string(), filled: z.string().optional() });

    it("reads back what was stored", () => {
        storeJson(`draft`, { message: `fix the build` });
        expect(storedJson(`draft`, Draft)).toEqual({ message: `fix the build` });
    });

    it("reads text that is not JSON, a value of another shape, and nothing at all as absent", () => {
        storeValue(`broken`, `{not json`);
        storeValue(`other`, JSON.stringify({ message: 42 }));
        expect([storedJson(`broken`, Draft), storedJson(`other`, Draft), storedJson(`missing`, Draft)]).toEqual([undefined, undefined, undefined]);
    });

    it("keeps nothing for a value JSON cannot hold", () => {
        const cyclic = { name: `loop` };
        Object.assign(cyclic, { self: cyclic });
        expect(() => storeJson(`loop`, cyclic)).not.toThrow();
        expect(storedValue(`loop`)).toBeUndefined();
    });
});

describe("the account's scope", () => {
    it("clears what the account left from both areas and keeps the device's", async () => {
        const theme = deviceKey(`ui-theme`);
        storeValue(theme, `dark`);
        storeValue(chatTabsKey(`sbx-1`), `{"tabs":[]}`);
        storeValue(chatTabsKey(`sbx-1`), `{"tabs":[]}`, `session`);
        storeValue(`intentic.inputHistory.sbx-1`, `["deploy it"]`);
        storeValue(`intentic.closedDrafts.sbx-2`, `{"tabs":[]}`);
        storeValue(`intentic.questionDraft.req-1`, `{}`);
        storeValue(`intentic.commitMessage.sbx-1`, `{"message":"wip"}`);
        storeValue(`intentic.activeSandboxId`, `sbx-1`);

        await clearAccountStorage();

        expect(storedKeys(``)).toEqual([theme]);
        expect(storedKeys(``, `session`)).toEqual([]);
        expect(storedValue(theme)).toBe(`dark`);
    });

    it("runs every clearer, one that throws included", async () => {
        const order: string[] = [];
        const stops = [
            onAccountCleared(() => {
                order.push(`first`);
                throw new Error(`broken clearer`);
            }),
            onAccountCleared(async () => {
                order.push(`second`);
            }),
        ];
        try {
            await clearAccountStorage();
        } finally {
            for (const stop of stops) {
                stop();
            }
        }
        expect(order).toEqual([`first`, `second`]);
    });

    it("names a family by its prefix and a device key by nothing", () => {
        const keyOf = accountKeys(`intentic.test-family.`);
        expect(keyOf(`a`, `b`)).toBe(`intentic.test-family.a.b`);
        expect([isAccountKey(keyOf(`a`)), isAccountKey(deviceKey(`ui-theme`)), isAccountKey(`intentic.rail.repos`)]).toEqual([true, false, false]);
    });
});
