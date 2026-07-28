import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { expect, test } from "vitest";
import {
    buildAuthorizeUrl,
    type ClaudeStore,
    ensureFreshToken,
    fileClaudeStore,
    newAccount,
    type StoredAccount,
    TokenRequestError,
    type TokenSet,
} from "./claude-credentials.js";

const silent = pino({ level: "silent" });

const storeDir = (): string => mkdtempSync(join(tmpdir(), "claude-store-"));

// One in-memory account keyed by id, matching the file store's account-keyed surface. `withRefreshLock` is a
// straight call: a single process's exclusion is the in-flight map's job, and these tests drive that directly.
const memoryStore = (initial?: StoredAccount): ClaudeStore & { current: () => StoredAccount | undefined } => {
    let account = initial;
    return {
        logger: silent,
        read: async (id) => (account?.id === id ? account : undefined),
        write: async (next) => {
            account = next;
        },
        clear: async (id) => {
            if (account?.id === id) {
                account = undefined;
            }
        },
        list: async () => (account !== undefined ? [{ id: account.id, label: account.label, connectedAt: account.connectedAt }] : []),
        withRefreshLock: (_id, act) => act(),
        current: () => account,
    };
};

const stored = (tokens: TokenSet): StoredAccount => ({ id: "a", label: "Claude", connectedAt: 0, ...tokens });

// Comfortably outside REFRESH_AHEAD_MS, so "valid" means valid rather than "about to be rotated".
const LONG = 3 * 60 * 60_000;

test("buildAuthorizeUrl produces a PKCE authorize URL with the verifier/state to round-trip", () => {
    const challenge = buildAuthorizeUrl();
    const url = new URL(challenge.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(challenge.state);
    expect(challenge.verifier.length).toBeGreaterThan(0);
});

test("newAccount mints an id and falls back to a default label", () => {
    const first = newAccount({ accessToken: "t" }, "");
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.label).toBe("Claude");
    expect(newAccount({ accessToken: "t" }, " work ").label).toBe("work");
});

test("ensureFreshToken returns undefined when the account is not connected", async () => {
    expect(await ensureFreshToken(memoryStore(), "a")).toBeUndefined();
});

test("ensureFreshToken returns the access token while it is still valid", async () => {
    const store = memoryStore(stored({ accessToken: "live", refreshToken: "r", expiresAt: Date.now() + LONG }));
    let refreshed = false;
    const token = await ensureFreshToken(store, "a", async () => {
        refreshed = true;
        return { accessToken: "new" };
    });
    expect(token).toBe("live");
    expect(refreshed).toBe(false);
});

// The window is deliberately wide: the token is snapshotted into the agent subprocess at spawn, so handing a
// turn one that is minutes from death means recovering mid-flight instead of never running dry.
test("ensureFreshToken rotates well before the real expiry rather than at the last second", async () => {
    const store = memoryStore(stored({ accessToken: "old", refreshToken: "r", expiresAt: Date.now() + 10 * 60_000 }));
    expect(await ensureFreshToken(store, "a", async () => ({ accessToken: "ahead" }))).toBe("ahead");
});

test("ensureFreshToken refreshes + persists when the token has expired, keeping account identity", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r1", expiresAt: Date.now() - 1000 }));
    const token = await ensureFreshToken(store, "a", async (refreshToken) => {
        expect(refreshToken).toBe("r1");
        return { accessToken: "fresh", refreshToken: "r2", expiresAt: Date.now() + LONG };
    });
    expect(token).toBe("fresh");
    expect(store.current()).toMatchObject({ id: "a", label: "Claude", accessToken: "fresh", refreshToken: "r2" });
});

test("ensureFreshToken keeps the old refresh token when the refresh response omits one", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "keep", expiresAt: Date.now() - 1000 }));
    await ensureFreshToken(store, "a", async () => ({ accessToken: "fresh" }));
    expect(store.current()).toMatchObject({ accessToken: "fresh", refreshToken: "keep" });
});

test("ensureFreshToken returns the (expired) token unchanged when there is no refresh token", async () => {
    const store = memoryStore(stored({ accessToken: "only", expiresAt: Date.now() - 1000 }));
    const token = await ensureFreshToken(store, "a", async () => {
        throw new Error("should not refresh without a refresh token");
    });
    expect(token).toBe("only");
});

/* The incident this file exists for: several turns starting at once (a fleet of agents, plus the model
 * catalog's own timer) all crossed the expiry window together, each POSTed the SAME refresh token, and
 * Anthropic's reuse-detection revoked the whole family — every live session died at once with
 * "401 OAuth access token has been revoked", including turns holding a token that had just been minted. */
test("concurrent callers refresh exactly once", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r1", expiresAt: Date.now() - 1000 }));
    let refreshes = 0;
    const refresh = async (): Promise<TokenSet> => {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { accessToken: "fresh", refreshToken: "r2", expiresAt: Date.now() + LONG };
    };
    const tokens = await Promise.all(Array.from({ length: 8 }, () => ensureFreshToken(store, "a", refresh)));
    expect(refreshes).toBe(1);
    expect(tokens).toEqual(Array.from({ length: 8 }, () => "fresh"));
});

// The loser of a cross-process race must ADOPT what the winner wrote. Replaying the refresh token the winner
// already spent is the revocation trigger itself, so "refresh anyway" is the one thing it must not do.
test("a caller that waited on the lock adopts the token the holder rotated", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r1", expiresAt: Date.now() - 1000 }));
    const rotate = async (): Promise<void> => {
        await store.write({ ...stored({ accessToken: "sibling", refreshToken: "r2", expiresAt: Date.now() + LONG }) });
    };
    const locked: ClaudeStore = {
        ...store,
        // Stand in for another process finishing its refresh while we blocked on the lock file.
        withRefreshLock: async (_id, act) => {
            await rotate();
            return act();
        },
    };
    const token = await ensureFreshToken(locked, "a", async () => {
        throw new Error("must not replay a refresh token the sibling already spent");
    });
    expect(token).toBe("sibling");
});

test("an invalid_grant marks the account revoked instead of retrying the dead token", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "dead", expiresAt: Date.now() - 1000 }));
    let attempts = 0;
    const refresh = async (): Promise<TokenSet> => {
        attempts += 1;
        throw new TokenRequestError(400, `{"error":"invalid_grant"}`);
    };
    expect(await ensureFreshToken(store, "a", refresh)).toBeUndefined();
    expect(store.current()?.revokedAt).toBeGreaterThan(0);
    // The second call must not present the dead token again — that replay is what revokes live sessions.
    expect(await ensureFreshToken(store, "a", refresh)).toBeUndefined();
    expect(attempts).toBe(1);
});

test("a transient refresh failure propagates and leaves the credential alone", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r1", expiresAt: Date.now() - 1000 }));
    await expect(ensureFreshToken(store, "a", async () => Promise.reject(new TokenRequestError(503, "upstream")))).rejects.toThrow("503");
    expect(store.current()?.revokedAt).toBeUndefined();
    expect(store.current()?.refreshToken).toBe("r1");
});

test("a revoked account surfaces as needsReauth in the list", async () => {
    const store = fileClaudeStore(storeDir(), silent);
    await store.write({ id: "acct-1", label: "Personal", connectedAt: 1, accessToken: "t", revokedAt: 5, revokedReason: "gone" });
    expect(await store.list()).toEqual([{ id: "acct-1", label: "Personal", connectedAt: 1, needsReauth: true, detail: "gone" }]);
});

// The catalog persists its discovered models as models.json in the SAME dir the account store scans, so an
// unparsed read surfaced it as a blank `{}` account: a phantom row in the picker, and — since the list is
// sorted by connectedAt and `accounts[0]` is the daemon's default — a coin-flip chance of the turn resolving
// no account at all.
test("fileClaudeStore ignores non-account json in the store dir", async () => {
    const dir = storeDir();
    const store = fileClaudeStore(dir, silent);
    await store.write({ id: "acct-1", label: "Personal", connectedAt: 1, accessToken: "t" });
    await writeFile(join(dir, "models.json"), JSON.stringify([{ id: "claude-opus-4-8", label: "Opus" }]));
    await writeFile(join(dir, "truncated.json"), `{"id":"half`);
    expect(await store.list()).toEqual([{ id: "acct-1", label: "Personal", connectedAt: 1 }]);
});

test("fileClaudeStore round-trips an account through the filesystem", async () => {
    const store = fileClaudeStore(storeDir(), silent);
    const account: StoredAccount = { id: "acct-1", label: "Work", connectedAt: 7, accessToken: "t", refreshToken: "r", scope: "s" };
    await store.write(account);
    expect(await store.read("acct-1")).toEqual(account);
    await store.clear("acct-1");
    expect(await store.read("acct-1")).toBeUndefined();
    expect(await store.list()).toEqual([]);
});

// A reader must never catch the file mid-write: a torn read parses to nothing, which used to degrade to "no
// such account" — indistinguishable, to the user, from a credential that disconnected itself.
test("fileClaudeStore writes atomically and leaves no temp files behind", async () => {
    const dir = storeDir();
    const store = fileClaudeStore(dir, silent);
    await Promise.all(
        Array.from({ length: 20 }, (_unused, index) => store.write({ id: "acct-1", label: "Work", connectedAt: 7, accessToken: `token-${index}` })),
    );
    const parsed = JSON.parse(await readFile(join(dir, "acct-1.json"), "utf8")) as StoredAccount;
    expect(parsed.accessToken).toMatch(/^token-\d+$/);
    expect(await store.list()).toEqual([{ id: "acct-1", label: "Work", connectedAt: 7 }]);
});

// The lock is what covers a SECOND daemon on a shared AGENT_AUTH_DIR — the in-flight map only sees its own
// process. Two stores over one dir stand in for two sandboxes.
test("withRefreshLock excludes a second holder over the same store dir", async () => {
    const dir = storeDir();
    const [first, second] = [fileClaudeStore(dir, silent), fileClaudeStore(dir, silent)];
    const order: string[] = [];
    const hold = (store: ClaudeStore, tag: string): Promise<void> =>
        store.withRefreshLock("acct-1", async () => {
            order.push(`${tag}:enter`);
            await new Promise((resolve) => setTimeout(resolve, 150));
            order.push(`${tag}:exit`);
        });
    await Promise.all([hold(first, "a"), hold(second, "b")]);
    // Whoever won, the other's critical section starts only after it closed.
    expect(order).toEqual(order[0] === "a:enter" ? ["a:enter", "a:exit", "b:enter", "b:exit"] : ["b:enter", "b:exit", "a:enter", "a:exit"]);
});

test("withRefreshLock steals a lock left behind by a dead holder", async () => {
    const dir = storeDir();
    const store = fileClaudeStore(dir, silent);
    // Backdated past LOCK_STALE_MS: a process that died mid-refresh must not wedge the credential forever.
    await writeFile(join(dir, "acct-1.refresh.lock"), "999999\n");
    const stale = new Date(Date.now() - 5 * 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(join(dir, "acct-1.refresh.lock"), stale, stale);
    expect(await store.withRefreshLock("acct-1", async () => "ran")).toBe("ran");
});
