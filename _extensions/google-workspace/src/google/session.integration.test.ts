import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "./accounts.js";
import { runtimeDir } from "./paths.js";
import { openSession } from "./session.js";

// The access-token cache, on a real filesystem: whether a second `gw` process reuses the token the first minted, and
// whether a rotated credential can answer from the old cache.

const connection = (refreshToken: string): Connection => ({
    name: "google",
    email: "ana@example.com",
    access: "write",
    mode: "user",
    credential: { mode: "user", clientId: "id", clientSecret: "secret", refreshToken },
    problem: undefined,
});

let root: string;
let env: NodeJS.ProcessEnv;
const fetchMock = vi.fn();

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gw-session-"));
    env = { INTENTIC_WORKSPACE: root };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: "minted-token", expires_in: 3600 }) });
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const clock = (): number => Date.parse("2026-08-09T12:00:00Z");

describe("openSession", () => {
    it("mints once and reuses it for the rest of the command", async () => {
        const session = openSession(connection("refresh-1"), env, root, clock);
        expect(await session.token()).toBe("minted-token");
        expect(await session.token()).toBe("minted-token");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("answers a second process from the file the first one wrote", async () => {
        await openSession(connection("refresh-1"), env, root, clock).token();
        fetchMock.mockClear();
        expect(await openSession(connection("refresh-1"), env, root, clock).token()).toBe("minted-token");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores the cached token once the credential behind it has changed", async () => {
        await openSession(connection("refresh-1"), env, root, clock).token();
        fetchMock.mockClear();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: "second-token", expires_in: 3600 }) });
        expect(await openSession(connection("refresh-2"), env, root, clock).token()).toBe("second-token");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("mints again for a token inside its expiry skew", async () => {
        await openSession(connection("refresh-1"), env, root, clock).token();
        fetchMock.mockClear();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: "fresh-token", expires_in: 3600 }) });
        const nearlyExpired = (): number => clock() + 3600_000 - 30_000;
        expect(await openSession(connection("refresh-1"), env, root, nearlyExpired).token()).toBe("fresh-token");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stores only the short-lived token, never the credential it came from", async () => {
        await openSession(connection("refresh-1"), env, root, clock).token();
        const written = await readFile(join(runtimeDir(root, "google"), "token.json"), "utf8");
        expect(written).toContain("minted-token");
        expect(written).not.toContain("refresh-1");
        expect(written).not.toContain("secret");
    });

    it("refuses on Google's terms, with the fix, when the refresh token is dead", async () => {
        fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "invalid_grant", error_description: "Bad Request" }) });
        await expect(openSession(connection("refresh-1"), env, root, clock).token()).rejects.toThrow(/die after 7 days/);
    });

    it("refresh() replaces the held token rather than returning the cached one", async () => {
        const session = openSession(connection("refresh-1"), env, root, clock);
        expect(await session.token()).toBe("minted-token");
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: "after-401", expires_in: 3600 }) });
        expect(await session.refresh()).toBe("after-401");
        expect(await session.token()).toBe("after-401");
    });
});
