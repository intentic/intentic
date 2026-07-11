import { expect, test } from "vitest";
import { buildAuthorizeUrl, type ClaudeStore, ensureFreshToken, newAccount, type StoredAccount, type TokenSet } from "./claude-credentials.js";

// One in-memory account keyed by id, matching the file store's account-keyed surface.
const memoryStore = (initial?: StoredAccount): ClaudeStore & { current: () => StoredAccount | undefined } => {
    let account = initial;
    return {
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
        current: () => account,
    };
};

const stored = (tokens: TokenSet): StoredAccount => ({ id: "a", label: "Claude", connectedAt: 0, ...tokens });

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
    const store = memoryStore(stored({ accessToken: "live", refreshToken: "r", expiresAt: Date.now() + 600_000 }));
    let refreshed = false;
    const token = await ensureFreshToken(store, "a", async () => {
        refreshed = true;
        return { accessToken: "new" };
    });
    expect(token).toBe("live");
    expect(refreshed).toBe(false);
});

test("ensureFreshToken refreshes + persists when the token has expired, keeping account identity", async () => {
    const store = memoryStore(stored({ accessToken: "stale", refreshToken: "r1", expiresAt: Date.now() - 1000 }));
    const token = await ensureFreshToken(store, "a", async (refreshToken) => {
        expect(refreshToken).toBe("r1");
        return { accessToken: "fresh", refreshToken: "r2", expiresAt: Date.now() + 600_000 };
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
