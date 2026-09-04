import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createLogger } from "../logger.js";
import { fileKeyedStore, readKeyedCredentials } from "./keyed-credentials.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

/* THE KEY STORE, against a real directory, because every claim worth making about it is a claim about files:
 * that a connect lands one, that a disconnect removes it, that a rename rewrites it, and above all that the
 * key never appears in what a route hands back. */

const storeIn = async () => {
    const dir = await mkdtemp(join(tmpdir(), "keyed-store-"));
    return { dir, store: fileKeyedStore({ dir, provider: "meta", providerName: "Meta", logger }) };
};

test("a connected key becomes a row, and the row has nowhere to carry the key", async () => {
    const { dir, store } = await storeIn();
    const account = await store.connect({ apiKey: "LLM|secret", label: "Work" });
    expect(account.label).toBe("Work");
    expect(JSON.stringify(account), "the account row carries the credential").not.toContain("secret");
    // The list a route serves is built from the same shape, so this holds for every reader, not just this one.
    expect(JSON.stringify(await store.list())).not.toContain("secret");
    // …and the key IS on disk, which is the other half: a store that silently dropped it would pass the
    // assertion above and fail every turn.
    expect(await readFile(join(dir, `${account.id}.json`), "utf8")).toContain("LLM|secret");
    expect((await store.credentials())[0]?.apiKey).toBe("LLM|secret");
});

test("a key with no name falls back to the provider's, since a pasted key says nothing about itself", async () => {
    const { store } = await storeIn();
    expect((await store.connect({ apiKey: "k" })).label).toBe("Meta");
    // Whitespace is not a name: it would render as a row with no text at all.
    expect((await store.connect({ apiKey: "k2", label: "   " })).label).toBe("Meta");
});

test("several keys live side by side, oldest first, and one disconnect leaves the rest", async () => {
    const { store } = await storeIn();
    const first = await store.connect({ apiKey: "one", label: "First" });
    const second = await store.connect({ apiKey: "two", label: "Second" });
    expect((await store.list()).map((account) => account.label)).toEqual(["First", "Second"]);
    await store.disconnect(first.id);
    expect((await store.list()).map((account) => account.id)).toEqual([second.id]);
});

test("renaming rewrites the name and keeps the key; blank restores the derived one", async () => {
    const { store } = await storeIn();
    const account = await store.connect({ apiKey: "one", label: "First" });
    expect((await store.rename(account.id, "Renamed"))?.label).toBe("Renamed");
    expect((await store.credentials())[0]?.apiKey, "a rename lost the credential").toBe("one");
    expect((await store.rename(account.id, "  "))?.label).toBe("Meta");
    // An id nobody stored answers undefined rather than writing a new file, which is what lets the route turn
    // it into a 404 instead of appearing to have applied a change to a row that is gone.
    expect(await store.rename("not-an-account", "x")).toBeUndefined();
});

/* A FILE THAT IS NOT AN ACCOUNT IS NOT AN ACCOUNT. The catalog cache lives in this same directory, and the
 * readiness rung is "does this directory hold a credential" — so a store that counted `models.json` would
 * report a provider connected on the strength of its own cache, and hand a turn an undefined key. */
test("foreign JSON in the auth directory is not mistaken for a credential", async () => {
    const { dir, store } = await storeIn();
    await writeFile(join(dir, "models.json"), JSON.stringify([{ id: "muse-spark-1.2", label: "Muse Spark 1.2" }]));
    await writeFile(join(dir, "notes.txt"), "not json at all");
    expect(await store.list()).toEqual([]);
    expect(await readKeyedCredentials(dir)).toEqual([]);
});

// A provider nobody has connected reads as empty rather than throwing: the directory does not exist yet on a
// fresh sandbox, and every readiness sweep asks this question before anything has created it.
test("an auth directory that does not exist reads as no accounts", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "keyed-missing-")), "never-created");
    expect(await readKeyedCredentials(dir)).toEqual([]);
});
