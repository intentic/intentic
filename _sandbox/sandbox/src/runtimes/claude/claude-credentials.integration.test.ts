import { mkdtempSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import {
    buildAuthorizeUrl,
    type ClaudeStore,
    displayLabel,
    ensureFreshToken,
    holdAccount,
    fileClaudeStore,
    newAccount,
    renameAccount,
    startClaudeRefresh,
    type StoredAccount,
    toAccount,
    TokenRequestError,
    type TokenSet,
} from "./claude-credentials.js";

const silent = pino({ level: "silent" });

const storeDir = (): string => mkdtempSync(join(tmpdir(), "claude-store-"));

// In-memory account keyed by id, matching the file store's surface. withRefreshLock just calls act(): a single
// process's exclusion is the in-flight map's job, tested directly.
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
        list: async () => (account !== undefined ? [{ id: account.id, label: displayLabel(account), connectedAt: account.connectedAt }] : []),
        withRefreshLock: (_id, act) => act(),
        current: () => account,
    };
};

// Unnamed on purpose; the store holds a name only when the user typed one, else it's derived on read.
const stored = (tokens: TokenSet): StoredAccount => ({ id: "a", connectedAt: 0, ...tokens });

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
    expect(first.label).toBeUndefined();
    expect(displayLabel(first)).toBe("Claude");
    expect(newAccount({ accessToken: "t" }, " work ").label).toBe("work");
});

test("newAccount names an unnamed account after the identity the sign-in reported", () => {
    expect(displayLabel(newAccount({ accessToken: "t", email: "a@example.com" }, ""))).toBe("a@example.com");
    expect(displayLabel(newAccount({ accessToken: "t", email: "a@example.com" }, "Work"))).toBe("Work");
});

test("renameAccount renames, and a blank name restores the derived one", () => {
    const account = stored({ accessToken: "t", email: "a@example.com" });
    expect(renameAccount(account, " Work ").label).toBe("Work");
    expect(renameAccount(account, "").label).toBeUndefined();
    expect(displayLabel(renameAccount(account, ""))).toBe("a@example.com");
    // No identity to derive from falls back to the provider default, never a nameless row.
    expect(displayLabel(renameAccount(stored({ accessToken: "t" }), ""))).toBe("Claude");
});

test("toAccount surfaces the identity alongside the user's own name", () => {
    expect(toAccount({ ...stored({ accessToken: "t", email: "a@example.com", organization: "Acme" }), label: "Work" })).toEqual({
        id: "a",
        label: "Work",
        connectedAt: 0,
        email: "a@example.com",
        organization: "Acme",
    });
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
    expect(store.current()).toMatchObject({ id: "a", accessToken: "fresh", refreshToken: "r2" });
});

test("ensureFreshToken keeps the old refresh token when the refresh response omits one", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "keep", expiresAt: Date.now() - 1000 }));
    await ensureFreshToken(store, "a", async () => ({ accessToken: "fresh" }));
    expect(store.current()).toMatchObject({ accessToken: "fresh", refreshToken: "keep" });
});

test("a refresh teaches an account who it is without touching the name it already has", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r", expiresAt: Date.now() - 1000 }));
    await ensureFreshToken(store, "a", async () => ({ accessToken: "fresh", email: "a@example.com", organization: "Acme" }));
    expect(store.current()).toMatchObject({ email: "a@example.com", organization: "Acme" });
    expect(displayLabel(store.current()!)).toBe("a@example.com");
});

test("a refresh without identity leaves the stored one standing", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r", email: "a@example.com", expiresAt: Date.now() - 1000 }));
    await ensureFreshToken(store, "a", async () => ({ accessToken: "fresh" }));
    expect(store.current()?.email).toBe("a@example.com");
});

test("ensureFreshToken returns the (expired) token unchanged when there is no refresh token", async () => {
    const store = memoryStore(stored({ accessToken: "only", expiresAt: Date.now() - 1000 }));
    const token = await ensureFreshToken(store, "a", async () => {
        throw new Error("should not refresh without a refresh token");
    });
    expect(token).toBe("only");
});

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

test("a caller that waited on the lock adopts the token the holder rotated", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r1", expiresAt: Date.now() - 1000 }));
    const rotate = async (): Promise<void> => {
        await store.write({ ...stored({ accessToken: "sibling", refreshToken: "r2", expiresAt: Date.now() + LONG }) });
    };
    const locked: ClaudeStore = {
        ...store,
        // Stands in for another process finishing its refresh while this one waited on the lock file.
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
    expect(await ensureFreshToken(store, "a", refresh)).toBeUndefined();
    expect(attempts).toBe(1);
});

test("a transient refresh failure propagates and leaves the credential alone", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r1", expiresAt: Date.now() - 1000 }));
    await expect(
        ensureFreshToken(store, "a", async () => {
            throw new TokenRequestError(503, "upstream");
        }),
    ).rejects.toThrow("503");
    expect(store.current()?.revokedAt).toBeUndefined();
    expect(store.current()?.refreshToken).toBe("r1");
});

test("a revoked account surfaces as needsReauth in the list", async () => {
    const store = fileClaudeStore(storeDir(), silent);
    await store.write({ id: "acct-1", label: "Personal", connectedAt: 1, accessToken: "t", revokedAt: 5, revokedReason: "gone" });
    expect(await store.list()).toEqual([{ id: "acct-1", label: "Personal", connectedAt: 1, needsReauth: true, detail: "gone" }]);
});

// models.json mirrors the model catalog's real file in this directory; an unparsed entry there must not surface as a
// phantom account.
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

test("fileClaudeStore writes the credential owner-only, temp file included", async () => {
    const dir = storeDir();
    const store = fileClaudeStore(dir, silent);
    await store.write({ id: "acct-1", label: "Work", connectedAt: 7, accessToken: "t", refreshToken: "r" });
    expect((await stat(join(dir, "acct-1.json"))).mode & 0o777).toBe(0o600);
});

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

// Two separate fileClaudeStore instances over one dir stand in for two daemons sharing AGENT_AUTH_DIR.
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
    expect(order).toEqual(order[0] === "a:enter" ? ["a:enter", "a:exit", "b:enter", "b:exit"] : ["b:enter", "b:exit", "a:enter", "a:exit"]);
});

test("withRefreshLock steals a lock left behind by a dead holder", async () => {
    const dir = storeDir();
    const store = fileClaudeStore(dir, silent);
    // Backdated past LOCK_STALE_MS so the lock reads as abandoned.
    await writeFile(join(dir, "acct-1.refresh.lock"), "999999\n");
    const stale = new Date(Date.now() - 5 * 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(join(dir, "acct-1.refresh.lock"), stale, stale);
    expect(await store.withRefreshLock("acct-1", async () => "ran")).toBe("ran");
});

test("a rotation waits while turns are holding the token", async () => {
    const store = memoryStore(stored({ accessToken: "held", refreshToken: "r", expiresAt: Date.now() + 10 * 60_000 }));
    const release = holdAccount("a");
    // Inside REFRESH_AHEAD_MS, so this would rotate if nothing were holding the account.
    expect(await ensureFreshToken(store, "a", async () => ({ accessToken: "rotated" }))).toBe("held");
    expect(store.current()?.accessToken).toBe("held");
    release();
    expect(await ensureFreshToken(store, "a", async () => ({ accessToken: "rotated" }))).toBe("rotated");
});

test("the wait is bounded: a token about to genuinely expire rotates even under a live turn", async () => {
    const store = memoryStore(stored({ accessToken: "dying", refreshToken: "r", expiresAt: Date.now() + 30_000 }));
    const release = holdAccount("a");
    // Past ROTATE_REGARDLESS_MS: waiting would let the token lapse, so it rotates despite the held turn.
    expect(await ensureFreshToken(store, "a", async () => ({ accessToken: "rotated" }))).toBe("rotated");
    release();
});

test("holds nest and release once: two turns on one account, and the second release is a no-op", async () => {
    const store = memoryStore(stored({ accessToken: "held", refreshToken: "r", expiresAt: Date.now() + 10 * 60_000 }));
    const first = holdAccount("a");
    const second = holdAccount("a");
    first();
    first();
    expect(await ensureFreshToken(store, "a", async () => ({ accessToken: "rotated" }))).toBe("held");
    second();
    expect(await ensureFreshToken(store, "a", async () => ({ accessToken: "rotated" }))).toBe("rotated");
});

test("the last turn's release rotates the token there and then", async () => {
    const store = memoryStore(stored({ accessToken: "held", refreshToken: "r", expiresAt: Date.now() + 3 * 60 * 60_000 }));
    const stop = startClaudeRefresh(store, 60 * 60_000, async () => ({ accessToken: "rotated" }));
    // The boot tick runs immediately; with nothing holding the account, it rotates right away.
    await vi.waitFor(() => expect(store.current()?.accessToken).toBe("rotated"), SETTLES);
    // With a turn now in flight, nothing rotates until the release lands.
    await store.write(stored({ accessToken: "second", refreshToken: "r", expiresAt: Date.now() + 3 * 60 * 60_000 }));
    const release = holdAccount("a");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.current()?.accessToken).toBe("second");
    release();
    await vi.waitFor(() => expect(store.current()?.accessToken).toBe("rotated"), SETTLES);
    stop();
});

test("a quiet moment does not rotate a token that is nowhere near expiry", async () => {
    const store = memoryStore(stored({ accessToken: "fresh", refreshToken: "r", expiresAt: Date.now() + 7 * 60 * 60_000 }));
    const stop = startClaudeRefresh(store, 60 * 60_000, async () => ({ accessToken: "rotated" }));
    const release = holdAccount("a");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.current()?.accessToken).toBe("fresh");
    stop();
});

test("a turn starting during a rotation gets the new token, not the one being superseded", async () => {
    const store = memoryStore(stored({ accessToken: "doomed", refreshToken: "r", expiresAt: Date.now() + 3 * 60 * 60_000 }));
    let began = (): void => {};
    let mint = (): void => {};
    const started = new Promise<void>((resolve) => {
        began = resolve;
    });
    const held = new Promise<void>((resolve) => {
        mint = resolve;
    });
    const stop = startClaudeRefresh(store, 60 * 60_000, async () => {
        began();
        await held;
        return { accessToken: "rotated" };
    });
    // Rotation has reached the provider and is waiting; the store still holds the token about to be superseded.
    await started;
    expect(store.current()?.accessToken).toBe("doomed");
    const resolving = ensureFreshToken(store, "a");
    mint();
    expect(await resolving).toBe("rotated");
    stop();
});

test("stopping the refresh loop unhooks the release trigger", async () => {
    const store = memoryStore(stored({ accessToken: "held", refreshToken: "r", expiresAt: Date.now() + 3 * 60 * 60_000 }));
    // Held before the loop starts, so stopping it is proven genuine rather than a rotation that already happened.
    const release = holdAccount("a");
    const stop = startClaudeRefresh(store, 60 * 60_000, async () => ({ accessToken: "rotated" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.current()?.accessToken).toBe("held");
    stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.current()?.accessToken).toBe("held");
});
