import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { expect, test, vi } from "vitest";
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
        list: async () => (account !== undefined ? [{ id: account.id, label: displayLabel(account), connectedAt: account.connectedAt }] : []),
        withRefreshLock: (_id, act) => act(),
        current: () => account,
    };
};

// Unnamed on purpose: the row's name is derived on read, so the store holds one only when the user typed it.
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
    // Nothing to name it after yet: nothing is STORED, and the display name falls back to the provider's.
    expect(first.label).toBeUndefined();
    expect(displayLabel(first)).toBe("Claude");
    expect(newAccount({ accessToken: "t" }, " work ").label).toBe("work");
});

// The whole reason a second account was indistinguishable from the first: unnamed, both rows said "Claude".
test("newAccount names an unnamed account after the identity the sign-in reported", () => {
    expect(displayLabel(newAccount({ accessToken: "t", email: "a@example.com" }, ""))).toBe("a@example.com");
    // A name the user typed outranks the derived one: it is the more specific answer, and theirs.
    expect(displayLabel(newAccount({ accessToken: "t", email: "a@example.com" }, "Work"))).toBe("Work");
});

test("renameAccount renames, and a blank name restores the derived one", () => {
    const account = stored({ accessToken: "t", email: "a@example.com" });
    expect(renameAccount(account, " Work ").label).toBe("Work");
    expect(renameAccount(account, "").label).toBeUndefined();
    expect(displayLabel(renameAccount(account, ""))).toBe("a@example.com");
    // Nothing to derive from: the provider default, never a nameless row.
    expect(displayLabel(renameAccount(stored({ accessToken: "t" }), ""))).toBe("Claude");
});

// The identity travels beside the label, not inside it: a renamed account must still be able to say whose it is.
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
    expect(store.current()).toMatchObject({ id: "a", accessToken: "fresh", refreshToken: "r2" });
});

test("ensureFreshToken keeps the old refresh token when the refresh response omits one", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "keep", expiresAt: Date.now() - 1000 }));
    await ensureFreshToken(store, "a", async () => ({ accessToken: "fresh" }));
    expect(store.current()).toMatchObject({ accessToken: "fresh", refreshToken: "keep" });
});

// A refresh answers on the same endpoint with the same envelope, so an account stored before any of this
// existed picks its identity up on the next rotation rather than staying anonymous forever.
test("a refresh teaches an account who it is without touching the name it already has", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r", expiresAt: Date.now() - 1000 }));
    await ensureFreshToken(store, "a", async () => ({ accessToken: "fresh", email: "a@example.com", organization: "Acme" }));
    expect(store.current()).toMatchObject({ email: "a@example.com", organization: "Acme" });
    // THE POINT OF DERIVING THE NAME: the row said "Claude" while the account was anonymous, and says who it
    // is the moment the provider tells us, without a rename and without a second sign-in.
    expect(displayLabel(store.current()!)).toBe("a@example.com");
});

// The mirror case: a response that says nothing about identity must not erase what we already knew.
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

/* The incident this file exists for: several turns starting at once (a fleet of agents, plus the model
 * catalog's own timer) all crossed the expiry window together, each POSTed the SAME refresh token, and
 * Anthropic's reuse-detection revoked the whole family: every live session died at once with
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
    // The second call must not present the dead token again: that replay is what revokes live sessions.
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
// unparsed read surfaced it as a blank `{}` account: a phantom row in the picker, and, since the list is
// sorted by connectedAt and `accounts[0]` is the daemon's default: a coin-flip chance of the turn resolving
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
// such account": indistinguishable, to the user, from a credential that disconnected itself.
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

// The lock is what covers a SECOND daemon on a shared AGENT_AUTH_DIR: the in-flight map only sees its own
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

/* ROTATION vs LIVE TURNS. Anthropic retires the previous access token the moment a refresh mints its
 * successor, and a turn's token is a snapshot in a subprocess env that cannot be updated, so a rotation
 * landing mid-turn kills every turn holding the old one. One real refresh did exactly that to three agents at
 * once. While a turn holds the account, the rotation waits. */
test("a rotation waits while turns are holding the token", async () => {
    const store = memoryStore(stored({ accessToken: "held", refreshToken: "r", expiresAt: Date.now() + 10 * 60_000 }));
    const release = holdAccount("a");
    // Inside REFRESH_AHEAD_MS, so this WOULD rotate, but breaking the turns holding it costs more than
    // carrying a token that is still ten minutes from expiry.
    expect(await ensureFreshToken(store, "a", async () => ({ accessToken: "rotated" }))).toBe("held");
    expect(store.current()?.accessToken).toBe("held");
    // The moment the last turn lets go, the next pass rotates as it always did.
    release();
    expect(await ensureFreshToken(store, "a", async () => ({ accessToken: "rotated" }))).toBe("rotated");
});

test("the wait is bounded: a token about to genuinely expire rotates even under a live turn", async () => {
    const store = memoryStore(stored({ accessToken: "dying", refreshToken: "r", expiresAt: Date.now() + 30_000 }));
    const release = holdAccount("a");
    // Past ROTATE_REGARDLESS_MS: waiting longer would let it lapse, which fails the NEXT turn too. The turns
    // still running are covered by the auth resume instead.
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

/* WAITING FOR A GAP ONLY WORKS IF THE GAP IS TAKEN WHEN IT COMES. Deferring at REFRESH_AHEAD_MS gave a busy
 * fleet half an hour to fall quiet in, and a fleet that never did rotated at the floor instead: into the most
 * turns it would ever have running. One such rotation refused five agents in twenty seconds. So the hunt starts
 * hours out and, crucially, fires off the RELEASE rather than off a timer that keeps missing the gaps. */
test("the last turn's release rotates the token there and then", async () => {
    const store = memoryStore(stored({ accessToken: "held", refreshToken: "r", expiresAt: Date.now() + 3 * 60 * 60_000 }));
    const stop = startClaudeRefresh(store, 60 * 60_000, async () => ({ accessToken: "rotated" }));
    // The boot tick runs immediately; nothing holds the account, so it takes the gap it is already in.
    await vi.waitFor(() => expect(store.current()?.accessToken).toBe("rotated"));
    // Now with a turn in flight: the release is the trigger, so nothing moves until it lands.
    await store.write(stored({ accessToken: "second", refreshToken: "r", expiresAt: Date.now() + 3 * 60 * 60_000 }));
    const release = holdAccount("a");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.current()?.accessToken).toBe("second");
    release();
    await vi.waitFor(() => expect(store.current()?.accessToken).toBe("rotated"));
    stop();
});

// The other half of the rule: early is only safe when it is also FREE. A token with most of its life left is
// left alone, so the sandbox is not re-minting on every turn boundary for no reason.
test("a quiet moment does not rotate a token that is nowhere near expiry", async () => {
    const store = memoryStore(stored({ accessToken: "fresh", refreshToken: "r", expiresAt: Date.now() + 7 * 60 * 60_000 }));
    const stop = startClaudeRefresh(store, 60 * 60_000, async () => ({ accessToken: "rotated" }));
    const release = holdAccount("a");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.current()?.accessToken).toBe("fresh");
    stop();
});

/* THE GAP IS ALSO WHEN THE NEXT TURN STARTS. A quiet rotation and a turn resolving its credential race over the
 * same instant, and the holder gate cannot separate them: the new turn holds nothing YET. Handing it the store's
 * current token would snapshot into a subprocess the exact token the in-flight mint is about to retire: the
 * collision, reintroduced through the door opened to avoid it. So the resolve waits for the mint. */
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
    // The boot tick's rotation has reached the provider and is waiting on it; the store still holds the token
    // that mint is about to supersede, which is exactly the state a turn must not resolve its credential in.
    await started;
    expect(store.current()?.accessToken).toBe("doomed");
    const resolving = ensureFreshToken(store, "a");
    mint();
    expect(await resolving).toBe("rotated");
    stop();
});

// A release arriving after the daemon tore the loop down must not reach into a store that is no longer running.
test("stopping the refresh loop unhooks the release trigger", async () => {
    const store = memoryStore(stored({ accessToken: "held", refreshToken: "r", expiresAt: Date.now() + 3 * 60 * 60_000 }));
    // Held across the boot tick, so the loop is genuinely stopped rather than having already rotated.
    const release = holdAccount("a");
    const stop = startClaudeRefresh(store, 60 * 60_000, async () => ({ accessToken: "rotated" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.current()?.accessToken).toBe("held");
    stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.current()?.accessToken).toBe("held");
});
