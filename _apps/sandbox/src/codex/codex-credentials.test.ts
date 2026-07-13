import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { emailOf, fileCodexStore, pollDeviceAuth, probeCodexHealth, startDeviceAuth, writeCodexConfig } from "./codex-credentials.js";

let home: string | undefined;
afterEach(async () => {
    vi.unstubAllGlobals();
    if (home !== undefined) {
        await rm(home, { recursive: true, force: true });
        home = undefined;
    }
});

// A ChatGPT id_token carries the account id in its (unverified) payload claim.
const idTokenWithAccount = (accountId: string): string =>
    `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.s`;
// An access token is a JWT the probe reads only for its `exp` (seconds since epoch).
const accessTokenWithExp = (expSeconds: number): string => `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

test("startDeviceAuth mints a device code, reading the usercode alias and coercing the string interval", async () => {
    // OpenAI's wire shape: code under `usercode`, interval as a string — must normalize to the number contract.
    const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ device_auth_id: "dev-1", usercode: "ABCD-1234", interval: "7" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await startDeviceAuth()).toEqual({
        userCode: "ABCD-1234",
        deviceAuthId: "dev-1",
        interval: 7,
        verificationUri: "https://auth.openai.com/codex/device",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://auth.openai.com/api/accounts/deviceauth/usercode", expect.objectContaining({ method: "POST" }));
});

test("pollDeviceAuth returns undefined while the user hasn't finished signing in", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("", { status: 403 })),
    );
    expect(await pollDeviceAuth("dev-1", "ABCD-1234")).toBeUndefined();
});

test("pollDeviceAuth exchanges the polled code + server verifier and decodes the account id", async () => {
    const idToken = idTokenWithAccount("acct-9");
    const fetchMock = vi.fn(async (url: string | URL) =>
        String(url).endsWith("/deviceauth/token")
            ? new Response(JSON.stringify({ authorization_code: "auth-code", code_verifier: "verifier-xyz" }), { status: 200 })
            : new Response(JSON.stringify({ id_token: idToken, access_token: "acc", refresh_token: "ref" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await pollDeviceAuth("dev-1", "ABCD-1234")).toEqual({ idToken, accessToken: "acc", refreshToken: "ref", accountId: "acct-9" });

    const exchange = fetchMock.mock.calls.find(([url]) => String(url) === "https://auth.openai.com/oauth/token");
    expect(exchange).toBeDefined();
    const body = exchange![1]!.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier-xyz");
    // The device grant is bound to the deviceauth callback, not the 1455 loopback.
    expect(body.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
});

test("emailOf decodes the signed-in email for auto-labeling", () => {
    const idToken = `h.${Buffer.from(JSON.stringify({ email: "dev@example.com" })).toString("base64url")}.s`;
    expect(emailOf(idToken)).toBe("dev@example.com");
    expect(emailOf("no.dots")).toBeUndefined();
});

test("the store writes each account's native auth.json under its own CODEX_HOME and lists them", async () => {
    home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const store = fileCodexStore(home);
    expect(await store.connected("a")).toBe(false);
    expect(await store.list()).toEqual([]);

    await store.write("a", "work", { idToken: "id.jwt", accessToken: "acc", refreshToken: "ref", accountId: "acct-1" });
    await store.write("b", "personal", { idToken: "id2.jwt", accessToken: "acc2", refreshToken: "ref2" });
    expect(await store.connected("a")).toBe(true);
    expect(store.home("a")).toBe(join(home, "a"));

    // Field names are the CLI's wire format (codex-rs login) — snake_case tokens, explicit null api key,
    // RFC 3339 last_refresh — so `codex` treats the file as its own. Written under the per-account dir.
    const auth = JSON.parse(await readFile(join(home, "a", "auth.json"), "utf8")) as Record<string, unknown>;
    expect(auth["OPENAI_API_KEY"]).toBeNull();
    expect(auth["tokens"]).toEqual({ id_token: "id.jwt", access_token: "acc", refresh_token: "ref", account_id: "acct-1" });
    expect(new Date(auth["last_refresh"] as string).getTime()).not.toBeNaN();

    expect((await store.list()).map((account) => account.label).toSorted()).toEqual(["personal", "work"]);

    await store.clear("a");
    expect(await store.connected("a")).toBe(false);
    expect((await store.list()).map((account) => account.label)).toEqual(["personal"]);
});

test("every CODEX_HOME gets the hardened config.toml, never overwritten once present", async () => {
    home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const store = fileCodexStore(home);
    await store.write("a", "work", { idToken: "id.jwt", accessToken: "acc", refreshToken: "ref" });

    // Codex has no telemetry env vars — the opt-outs must land as $CODEX_HOME/config.toml keys.
    const configPath = join(home, "a", "config.toml");
    const config = await readFile(configPath, "utf8");
    expect(config).toContain("check_for_update_on_startup = false");
    expect(config).toContain("[analytics]");
    expect(config).toContain("[feedback]");
    expect(config).toContain('metrics_exporter = "none"');

    // The agent may extend the file — a later token refresh (writeTokens) must not clobber it.
    await writeFile(configPath, `${config}\n[mcp_servers.custom]\ncommand = "x"\n`);
    await store.writeTokens("a", { idToken: "id.jwt", accessToken: "acc2", refreshToken: "ref2" });
    expect(await readFile(configPath, "utf8")).toContain("[mcp_servers.custom]");

    // The fallback CODEX_HOME is the store's base dir itself — its config.toml must not list as a phantom account.
    await writeCodexConfig(home);
    await readFile(join(home, "config.toml"), "utf8");
    expect((await store.list()).map((account) => account.label)).toEqual(["work"]);
});

test("probeCodexHealth stays healthy and makes NO network call while the access token is still valid", async () => {
    home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const store = fileCodexStore(home);
    await store.write("a", "work", {
        idToken: idTokenWithAccount("acct-1"),
        accessToken: accessTokenWithExp(nowSeconds() + 3600),
        refreshToken: "ref",
        accountId: "acct-1",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await probeCodexHealth(store, "a")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
});

test("probeCodexHealth refreshes an expired token, persists the rotation, and preserves id_token/account_id", async () => {
    home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const store = fileCodexStore(home);
    const idToken = idTokenWithAccount("acct-1");
    await store.write("a", "work", { idToken, accessToken: accessTokenWithExp(nowSeconds() - 10), refreshToken: "ref-old", accountId: "acct-1" });
    const newAccess = accessTokenWithExp(nowSeconds() + 3600);
    // The refresh response omits id_token — the prior one (and its account id) must be preserved.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: newAccess, refresh_token: "ref-new" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await probeCodexHealth(store, "a")).toBeUndefined();
    const body = fetchMock.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ref-old");
    const auth = JSON.parse(await readFile(join(home, "a", "auth.json"), "utf8")) as { tokens: Record<string, string> };
    expect(auth.tokens).toEqual({ id_token: idToken, access_token: newAccess, refresh_token: "ref-new", account_id: "acct-1" });
});

test("probeCodexHealth flags needsReauth when the refresh token is revoked (4xx)", async () => {
    home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const store = fileCodexStore(home);
    await store.write("a", "work", {
        idToken: idTokenWithAccount("acct-1"),
        accessToken: accessTokenWithExp(nowSeconds() - 10),
        refreshToken: "ref",
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("invalid_grant", { status: 400 })),
    );

    expect(await probeCodexHealth(store, "a")).toEqual({ needsReauth: true, detail: expect.stringContaining("revoked or expired") });
});

test("probeCodexHealth fails open (undefined) on a transient 5xx / network error", async () => {
    home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const store = fileCodexStore(home);
    await store.write("a", "work", {
        idToken: idTokenWithAccount("acct-1"),
        accessToken: accessTokenWithExp(nowSeconds() - 10),
        refreshToken: "ref",
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("upstream down", { status: 503 })),
    );

    expect(await probeCodexHealth(store, "a")).toBeUndefined();
});

test("probeCodexHealth treats a rotation race (refresh token changed on disk) as healthy, not revoked", async () => {
    home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const store = fileCodexStore(home);
    const idToken = idTokenWithAccount("acct-1");
    await store.write("a", "work", { idToken, accessToken: accessTokenWithExp(nowSeconds() - 10), refreshToken: "ref-old", accountId: "acct-1" });
    // The 4xx would normally read as revoked — but simulate the Codex CLI rotating the token first (so our
    // stale token is what got rejected). The probe re-reads the file, sees the changed token, and stays healthy.
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            await store.writeTokens("a", {
                idToken,
                accessToken: accessTokenWithExp(nowSeconds() + 3600),
                refreshToken: "ref-cli-rotated",
                accountId: "acct-1",
            });
            return new Response("invalid_grant", { status: 400 });
        }),
    );

    expect(await probeCodexHealth(store, "a")).toBeUndefined();
});
