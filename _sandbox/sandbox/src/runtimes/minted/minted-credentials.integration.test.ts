import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../logger.js";
import { fileMintedStore, readMintedCredentials } from "./minted-credentials.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

// The minted key store against a real directory: sign-in, disconnect, rename and the estate all round-trip through
// files, and the key must never appear in what a route hands back.

const storeIn = async () => {
    const dir = await mkdtemp(join(tmpdir(), "minted-store-"));
    return { dir, store: fileMintedStore({ dir, provider: "meta", providerName: "Meta", logger }) };
};

afterEach(() => {
    jest.restoreAllMocks();
});

test("a minted key becomes a row, and the row has nowhere to carry the key", async () => {
    const { dir, store } = await storeIn();
    const account = await store.connect({ apiKey: "LLM|secret", variant: "meta", email: "someone@example.com" });
    // Nothing typed a name, so the row names itself after the sign-in it came from.
    expect(account.label).toBe("someone@example.com");
    expect(JSON.stringify(account), "the account row carries the credential").not.toContain("secret");
    // The list a route serves is built from the same shape, so this holds for every reader, not just this one.
    expect(JSON.stringify(await store.list())).not.toContain("secret");
    // The key IS on disk, the other half: a store that silently dropped it would pass the assertion above and fail
    // every turn.
    expect(await readFile(join(dir, `${account.id}.json`), "utf8")).toContain("LLM|secret");
    expect((await store.credentials())[0]?.apiKey).toBe("LLM|secret");
});

// A store that dropped the variant would send a mainland key to api.z.ai, reading as a bad credential rather than a
// wrong host.
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

// The one connect rule (account-identity.ts): signing in again as the same person on the same estate lands on the same
// id, keeping its name and place, so every conversation pinned to it carries on; another estate is another account.
test("signing in again as the same person on the same estate lands on the same account, with the new key", async () => {
    const { store } = await storeIn();
    const first = await store.connect({ apiKey: "old-key", variant: "meta", email: "me@example.com" });
    await store.rename(first.id, "Work");
    const again = await store.connect({ apiKey: "new-key", variant: "meta", email: "ME@example.com" });
    expect(again).toEqual({ ...first, label: "Work", email: "ME@example.com" });
    expect((await store.credentials()).map((account) => [account.id, account.apiKey])).toEqual([[first.id, "new-key"]]);
    const elsewhere = await store.connect({ apiKey: "cn-key", variant: "bigmodel", email: "me@example.com" });
    expect(elsewhere.id).not.toBe(first.id);
    expect(await store.list()).toHaveLength(2);
});

// Clock pinned so the millisecond collision between two connects is the every-run case, not a rare flake; with equal
// stamps, "oldest first" falls back to readdir's arbitrary order.
test("several keys live side by side, oldest first, and one disconnect leaves the rest", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { store } = await storeIn();
    const first = await store.connect({ apiKey: "one", variant: "meta", email: "First" });
    const second = await store.connect({ apiKey: "two", variant: "meta", email: "Second" });
    const rows = await store.list();
    // The stamps themselves are asserted, not just the returned order, since equal stamps can still sort right by
    // filesystem accident.
    expect(new Set(rows.map((account) => account.connectedAt)).size, "both connects took the same stamp").toBe(2);
    expect(rows.map((account) => account.label)).toEqual(["First", "Second"]);
    await store.disconnect(first.id);
    expect((await store.list()).map((account) => account.id)).toEqual([second.id]);
});

// Two sign-ins on two estates can be approved in the same second, each reading the same newest row to stamp past;
// distinct stamps, not just readdir order, are what must survive.
test("two connects in flight together take distinct stamps, in the order they were called", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
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
    // An unknown id answers undefined rather than writing a new file, so the route can 404 instead of seeming to rename
    // a row that's gone.
    expect(await store.rename("not-an-account", "x")).toBeUndefined();
});

// The catalog cache lives in this same directory; counting it as a credential would report a provider connected on the
// strength of its own cache and hand a turn an undefined key.
test("foreign JSON in the auth directory is not mistaken for a credential", async () => {
    const { dir, store } = await storeIn();
    await writeFile(join(dir, "models-meta.json"), JSON.stringify([{ id: "muse-spark-1.2", label: "Muse Spark 1.2" }]));
    await writeFile(join(dir, "notes.txt"), "not json at all");
    expect(await store.list()).toEqual([]);
    expect(await readMintedCredentials(dir)).toEqual([]);
});

// A provider nobody has connected reads as empty rather than throwing: the directory doesn't exist yet on a fresh
// sandbox, and every readiness sweep asks this before anything creates it.
test("an auth directory that does not exist reads as no accounts", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "minted-missing-")), "never-created");
    expect(await readMintedCredentials(dir)).toEqual([]);
});

// Signed out is only a missing file: an account the daemon cannot read must not show as never connected.
test("a credential file that cannot be read is an error, not a missing account", async () => {
    const { dir, store } = await storeIn();
    await mkdir(join(dir, "acct-1.json"), { recursive: true });
    await expect(store.list()).rejects.toThrow("EISDIR");
    expect(await store.rename("never-connected", "x")).toBeUndefined();
});
