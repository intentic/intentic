import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RefreshTokenDaemon, storeRefreshTokenAsAgent, storeRefreshTokenAsExtension } from "./refresh-token.js";

const write = { id: "office-mail", binding: { tenantId: "t" }, previous: "old", refreshToken: "new" };

test("the agent's CLI stores through the contract's own route with the agent token, and a newer rotation supersedes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refresh-token-"));
    try {
        await writeFile(join(dir, "agent.token"), "agent-secret\n");
        const env = { INTENTIC_AGENT_TOKEN_PATH: join(dir, "agent.token"), SANDBOX_PORT: "9999", INTENTIC_TURN_OWNER: "conv" };
        const seen: { url: string; init: RequestInit }[] = [];
        const answering = (status: number) => async (url: string, init: RequestInit) => {
            seen.push({ url, init });
            return new Response("{}", { status });
        };
        expect(await storeRefreshTokenAsAgent({ ...write, login: true }, { env, http: answering(200) })).toBe("stored");
        expect(seen[0]?.url).toBe("http://127.0.0.1:9999/capabilities/office-mail/oauth-token");
        expect(new Headers(seen[0]?.init.headers).get("x-intentic-agent")).toBe("agent-secret");
        expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ binding: { tenantId: "t" }, previous: "old", refreshToken: "new", login: true });
        expect(await storeRefreshTokenAsAgent(write, { env, http: answering(409) })).toBe("superseded");
        await expect(storeRefreshTokenAsAgent({ ...write, login: true }, { env, http: answering(409) })).rejects.toThrow("did not store");
        await expect(storeRefreshTokenAsAgent(write, { env, http: answering(404) })).rejects.toThrow("404");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a listener process stores through its typed client, and only a rotation may be superseded", async () => {
    const calls: unknown[] = [];
    const apiAnswering = (failure?: { status: number }): RefreshTokenDaemon => ({
        daemon: {
            rpc: {
                capabilities: {
                    oauthToken: async (input) => {
                        calls.push(input);
                        if (failure !== undefined) {
                            throw Object.assign(new Error("refused"), failure);
                        }
                        return { ok: true } as const;
                    },
                },
            },
        },
    });
    expect(await storeRefreshTokenAsExtension(apiAnswering(), write)).toBe("stored");
    expect(calls[0]).toEqual({ ...write, login: false });
    expect(await storeRefreshTokenAsExtension(apiAnswering({ status: 409 }), write)).toBe("superseded");
    await expect(storeRefreshTokenAsExtension(apiAnswering({ status: 403 }), write)).rejects.toThrow("refused");
});
