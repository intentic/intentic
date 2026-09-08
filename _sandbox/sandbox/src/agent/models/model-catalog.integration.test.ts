import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { jsonFile } from "../../store/json-file.js";
import { ABSENT_FOR_MS, discoveredCatalog } from "./model-catalog.js";

// Pins the catalog properties every provider relies on, asserted once here over bare ids instead of per-provider.

const storeAt = (path = join(mkdtempSync(join(tmpdir(), "model-catalog-")), "models.json")) => ({
    path,
    file: jsonFile<string[]>(path, {
        parse: (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : undefined),
        fallback: () => [],
    }),
});

// The shape a provider's `fromLive`/`fromStored` produce: ids in, rows plus a default out.
const toCatalog = (ids: readonly string[]): { models: string[]; default: string } => ({ models: [...ids], default: ids[0] ?? "" });

const catalogOf = (discover: () => Promise<readonly string[]>, store?: ReturnType<typeof storeAt>) =>
    discoveredCatalog({
        ttlMs: 60_000,
        discover,
        idOf: (id: string) => id,
        ...(store === undefined ? {} : { store: store.file }),
        toStored: (ids: readonly string[]) => [...ids],
        seed: ["seed"],
        fromLive: toCatalog,
        fromStored: toCatalog,
    });

test("a live answer is served, persisted, and then cached for the TTL", async () => {
    const discover = vi.fn(async () => ["a", "b"]);
    const store = storeAt();
    const catalog = catalogOf(discover, store);

    expect(await catalog.models()).toEqual({ models: ["a", "b"], default: "a" });
    expect(await catalog.models()).toEqual({ models: ["a", "b"], default: "a" });
    // One ask, two reads: the picker polls, and each poll must not be a round-trip to the vendor.
    expect(discover).toHaveBeenCalledTimes(1);
    expect(await store.file.read()).toEqual(["a", "b"]);
});

// Only Date is faked: the store's own writes are real file I/O and must keep their real timers.
afterEach(() => {
    vi.useRealTimers();
});

// A vendor that stops listing a model it served minutes ago is usually out of capacity for it, so the row is held for
// the window rather than taken as retired. Without this the shrunk list becomes the served catalog AND the
// last-known-good file, which is what moves an open chat's pinned model onto the catalog's default.
test("holds a row the vendor has just stopped listing, behind the rows it still serves", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let listing = ["a", "b"];
    const store = storeAt();
    const catalog = catalogOf(async () => listing, store);
    expect(await catalog.models()).toEqual({ models: ["a", "b"], default: "a" });

    listing = ["b"];
    // Past the TTL, so this read is a second discovery rather than the cached answer.
    vi.advanceTimersByTime(61_000);

    // Still offered, and still pinnable — but last, so the default follows what the vendor does serve.
    expect(await catalog.models()).toEqual({ models: ["b", "a"], default: "b" });
    expect(await store.file.read()).toEqual(["b", "a"]);
});

test("lets a row go once the vendor has stopped listing it for the whole window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let listing = ["a", "b"];
    const store = storeAt();
    const catalog = catalogOf(async () => listing, store);
    await catalog.models();

    listing = ["b"];
    vi.advanceTimersByTime(ABSENT_FOR_MS + 1);

    expect(await catalog.models()).toEqual({ models: ["b"], default: "b" });
    expect(await store.file.read()).toEqual(["b"]);
});

test("a seeded answer is not cached, so the next read retries the vendor", async () => {
    const discover = vi.fn(async () => []);
    const catalog = catalogOf(discover);

    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });
    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });
    expect(discover).toHaveBeenCalledTimes(2);
});

test("the persisted list outranks the seed floor once discovery goes quiet", async () => {
    const store = storeAt();
    await catalogOf(async () => ["real"], store).models();

    const offline = catalogOf(async () => [], storeAt(store.path));
    expect(await offline.models()).toEqual({ models: ["real"], default: "real" });
});

// The foreign-shaped case is the ordinary aftermath of a rollback; it must not crash the read path.
test("an absent, unreadable or foreign-shaped file reads as nothing remembered", async () => {
    const store = storeAt();
    const catalog = catalogOf(async () => [], store);

    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });

    writeFileSync(store.path, "{not json");
    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });

    writeFileSync(store.path, JSON.stringify({ models: ["a"], shape: "from a newer build" }));
    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });
});

// What a turn proved the vendor accepts is persisted and served at once, without waiting on discovery.
test("record persists and serves immediately", async () => {
    const store = storeAt();
    const catalog = catalogOf(async () => [], store);

    await catalog.record(["proved"]);
    expect(await catalog.models()).toEqual({ models: ["proved"], default: "proved" });
    expect(await store.file.read()).toEqual(["proved"]);
});

test("a rejecting vendor is a quiet fallback, not a thrown error", async () => {
    const catalog = catalogOf(async () => {
        throw new Error("ECONNREFUSED");
    });
    await expect(catalog.models()).rejects.toThrow("ECONNREFUSED");
});

// `live` exposes the raw items only when the in-hand answer is actually live, not from file or floor; Cursor relies on
// this to avoid guessing at an untranslatable effort tier.
test("live answers with the vendor's items only while a live answer is what is in hand", async () => {
    const store = storeAt();
    expect(await catalogOf(async () => [], store).live()).toBeUndefined();

    const catalog = catalogOf(async () => ["a"], store);
    expect(await catalog.live()).toEqual(["a"]);
});

// Disconnecting an account must forget the cached answer, or it's offered for the rest of the TTL after the credential
// is gone.
test("forget drops the cached answer", async () => {
    let available = ["live"];
    const catalog = catalogOf(async () => available);
    await catalog.models();

    available = [];
    catalog.forget();
    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });
});
