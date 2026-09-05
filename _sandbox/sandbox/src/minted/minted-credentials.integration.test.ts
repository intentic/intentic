import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "../logger.js";
import { fileMintedStore, readMintedCredentials } from "./minted-credentials.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

/* THE MINTED KEY STORE, against a real directory, because every claim worth making about it is a claim about
 * files: that a sign-in lands one, that a disconnect removes it, that a rename rewrites it, that the estate it
 * was minted on survives the round trip, and above all that the key never appears in what a route hands back. */

const storeIn = async () => {
    const dir = await mkdtemp(join(tmpdir(), "minted-store-"));
    return { dir, store: fileMintedStore({ dir, provider: "meta", providerName: "Meta", logger }) };
};

afterEach(() => {
    vi.restoreAllMocks();
});

test("a minted key becomes a row, and the row has nowhere to carry the key", async () => {
    const { dir, store } = await storeIn();
    const account = await store.connect({ apiKey: "LLM|secret", variant: "meta", email: "someone@example.com" });
    // Nothing typed a name, so the row names itself after the sign-in it came from.
    expect(account.label).toBe("someone@example.com");
    expect(JSON.stringify(account), "the account row carries the credential").not.toContain("secret");
    // The list a route serves is built from the same shape, so this holds for every reader, not just this one.
    expect(JSON.stringify(await store.list())).not.toContain("secret");
    // …and the key IS on disk, which is the other half: a store that silently dropped it would pass the
    // assertion above and fail every turn.
    expect(await readFile(join(dir, `${account.id}.json`), "utf8")).toContain("LLM|secret");
    expect((await store.credentials())[0]?.apiKey).toBe("LLM|secret");
});

/* THE ESTATE SURVIVES THE ROUND TRIP, and this is the assertion with a real turn behind it: the variant is what
 * the turn and the catalog dial their host from, so a store that dropped it would send a mainland key to
 * api.z.ai and the refusal would read as "your credential is bad". */
test("the estate a key was minted on is stored and read back", async () => {
    const { store } = await storeIn();
    await store.connect({ apiKey: "k", variant: "bigmodel" });
    expect((await store.credentials())[0]?.variant).toBe("bigmodel");
});

test("a sign-in that named nobody falls back to the provider's name", async () => {
    const { store } = await storeIn();
    expect((await store.connect({ apiKey: "k", variant: "meta" })).label).toBe("Meta");
    // Whitespace is not an identity: it would render as a row with no text at all.
    expect((await store.connect({ apiKey: "k2", variant: "meta", email: "   " })).label).toBe("Meta");
});

/* THE CLOCK IS PINNED, and that is the whole point of this test rather than an incidental detail. A mint takes
 * no time once the user has approved, so whether two connects straddle a millisecond boundary is a property of
 * the machine, not of the store: this assertion held for months and then reddened one CI run on a runner fast
 * enough to put both in the same tick. Frozen, that collision is the every-run case — and with equal stamps
 * "oldest first" falls back to whatever readdir says about two random UUID filenames, so the order a user reads
 * means nothing. */
test("several keys live side by side, oldest first, and one disconnect leaves the rest", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { store } = await storeIn();
    const first = await store.connect({ apiKey: "one", variant: "meta", email: "First" });
    const second = await store.connect({ apiKey: "two", variant: "meta", email: "Second" });
    const rows = await store.list();
    // The stamps, not just the order they came back in: equal stamps that happen to sort the right way on this
    // filesystem are the exact green that let the bug reach main, so the ordering key is what gets asserted.
    expect(new Set(rows.map((account) => account.connectedAt)).size, "both connects took the same stamp").toBe(2);
    expect(rows.map((account) => account.label)).toEqual(["First", "Second"]);
    await store.disconnect(first.id);
    expect((await store.list()).map((account) => account.id)).toEqual([second.id]);
});

// …and connect is reached from a route, so "at the same time" includes literally at the same time: two sign-ins
// on two estates can be approved in the same second, and each would read the same newest row to stamp itself
// past. Distinct stamps are the property that carries the order, so they are asserted directly — two rows that
// merely happen to come back the right way round from one readdir would not survive the next reader.
test("two connects in flight together take distinct stamps, in the order they were called", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { store } = await storeIn();
    await Promise.all([
        store.connect({ apiKey: "one", variant: "meta", email: "First" }),
        store.connect({ apiKey: "two", variant: "meta", email: "Second" }),
    ]);
    const rows = await store.list();
    expect(new Set(rows.map((account) => account.connectedAt)).size, "both connects took the same stamp").toBe(2);
    expect(rows.map((account) => account.label)).toEqual(["First", "Second"]);
});

test("renaming rewrites the name and keeps the key and the estate; blank restores the derived one", async () => {
    const { store } = await storeIn();
    const account = await store.connect({ apiKey: "one", variant: "meta", email: "someone@example.com" });
    expect((await store.rename(account.id, "Renamed"))?.label).toBe("Renamed");
    expect((await store.credentials())[0]?.apiKey, "a rename lost the credential").toBe("one");
    expect((await store.credentials())[0]?.variant, "a rename lost the estate").toBe("meta");
    // Blank clears the user's label, so the row falls back to the sign-in identity rather than to nothing.
    expect((await store.rename(account.id, "  "))?.label).toBe("someone@example.com");
    // An id nobody stored answers undefined rather than writing a new file, which is what lets the route turn
    // it into a 404 instead of appearing to have applied a change to a row that is gone.
    expect(await store.rename("not-an-account", "x")).toBeUndefined();
});

/* A FILE THAT IS NOT AN ACCOUNT IS NOT AN ACCOUNT. The catalog cache lives in this same directory, and the
 * readiness rung is "does this directory hold a credential" — so a store that counted `models-meta.json` would
 * report a provider connected on the strength of its own cache, and hand a turn an undefined key. */
test("foreign JSON in the auth directory is not mistaken for a credential", async () => {
    const { dir, store } = await storeIn();
    await writeFile(join(dir, "models-meta.json"), JSON.stringify([{ id: "muse-spark-1.2", label: "Muse Spark 1.2" }]));
    await writeFile(join(dir, "notes.txt"), "not json at all");
    expect(await store.list()).toEqual([]);
    expect(await readMintedCredentials(dir)).toEqual([]);
});

// A provider nobody has connected reads as empty rather than throwing: the directory does not exist yet on a
// fresh sandbox, and every readiness sweep asks this question before anything has created it.
test("an auth directory that does not exist reads as no accounts", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "minted-missing-")), "never-created");
    expect(await readMintedCredentials(dir)).toEqual([]);
});
