import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { jsonFile } from "../store/json-file.js";
import { discoveredCatalog } from "./model-catalog.js";

/* THE LADDER SIX PROVIDERS STAND ON. Each of them used to carry its own copy, so each of these properties had
 * six chances to be wrong; they are asserted once, here, over a catalog of bare ids. */

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

/* THE PROPERTY EVERY COPY COMMENTED AND ONLY THIS TEST CHECKS: a fallback answer is NOT cached, so the read
 * after it asks again. That is the difference between a sandbox that recovers the moment an account is
 * connected and one that shows a seeded row for the rest of the minute. */
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

/* Absent, not JSON, and JSON of a shape this build does not recognise all mean the same thing: nothing
 * remembered, so serve the floor. The third case is the ordinary aftermath of a rollback, and it must not be a
 * crash on the read path of a picker. */
test("an absent, unreadable or foreign-shaped file reads as nothing remembered", async () => {
    const store = storeAt();
    const catalog = catalogOf(async () => [], store);

    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });

    writeFileSync(store.path, "{not json");
    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });

    writeFileSync(store.path, JSON.stringify({ models: ["a"], shape: "from a newer build" }));
    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });
});

// The self-heal path: what a turn proved (the vendor named it while rejecting something else) is persisted and
// served at once, without waiting for a discovery that may never succeed on this account.
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

/* `live` is the rung, made visible: the raw items when the answer in hand IS live, and nothing when it came
 * off the file or the floor. Cursor turns on this distinction — an effort tier it cannot translate from the
 * vendor's own parameter definitions is one it must not guess at. */
test("live answers with the vendor's items only while a live answer is what is in hand", async () => {
    const store = storeAt();
    expect(await catalogOf(async () => [], store).live()).toBeUndefined();

    const catalog = catalogOf(async () => ["a"], store);
    expect(await catalog.live()).toEqual(["a"]);
});

// Disconnecting an account has to forget the cached answer too, or it keeps being offered for the rest of the
// TTL after the credential is gone.
test("forget drops the cached answer", async () => {
    let available = ["live"];
    const catalog = catalogOf(async () => available);
    await catalog.models();

    available = [];
    catalog.forget();
    expect(await catalog.models()).toEqual({ models: ["seed"], default: "seed" });
});
