import { afterEach, expect, test, vi } from "vitest";
import { createCliProxyClient, nextRestartDelay, RESTART_DELAY_BASE_MS, RESTART_DELAY_CAP_MS } from "./translator.js";

// The restart ladder in one property: crash-on-arrival climbs, a stable run resets. This policy is what keeps
// a proxy that exits immediately (a taken port, a bad binary) from being respawned every 5s forever.

test("consecutive fast exits double the delay up to the cap", () => {
    let delay = RESTART_DELAY_BASE_MS;
    const seen: number[] = [];
    for (let i = 0; i < 8; i += 1) {
        delay = nextRestartDelay(delay, 100);
        seen.push(delay);
    }
    expect(seen).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, RESTART_DELAY_CAP_MS, RESTART_DELAY_CAP_MS, RESTART_DELAY_CAP_MS]);
});

test("a run that stayed up resets the ladder", () => {
    expect(nextRestartDelay(RESTART_DELAY_CAP_MS, 61_000)).toBe(RESTART_DELAY_BASE_MS);
});

afterEach(() => vi.unstubAllGlobals());

test("starts Kimi Code's headless device login through CLIProxyAPI", async () => {
    const fetchMock = vi.fn(async () =>
        Response.json({ url: "https://kimi.com/device?code=ABCD", user_code: "ABCD", state: "kmi-1", flow: "device" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createCliProxyClient({ managementUrl: "http://127.0.0.1:8789/v0/management", token: "local", configPath: "/tmp/config.yaml" });

    await expect(client.connect("kimi")).resolves.toEqual({
        url: "https://kimi.com/device?code=ABCD",
        code: "ABCD",
        state: "kmi-1",
        flow: "device",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8789/v0/management/kimi-auth-url", {
        headers: { authorization: "Bearer local" },
    });
});

test("reads Kimi's provider-scoped model definitions without owned_by inference", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                channel: "kimi",
                models: [
                    {
                        id: "kimi-k3",
                        display_name: "Kimi K3",
                        description: "Flagship",
                        owned_by: "moonshot",
                        thinking: { levels: ["low", "high", "max"] },
                    },
                ],
            }),
        ),
    );
    const client = createCliProxyClient({ managementUrl: "http://127.0.0.1:8789/v0/management", token: "local", configPath: "/tmp/config.yaml" });

    await expect(client.models("kimi")).resolves.toEqual([
        { id: "kimi-k3", label: "Kimi K3", description: "Flagship", efforts: ["low", "high", "max"] },
    ]);
});

test("projects CLIProxyAPI's Kimi auth files as connected subscription accounts", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ files: [{ name: "kimi-user.json", provider: "kimi", label: "Kimi User" }] })),
    );
    const client = createCliProxyClient({ managementUrl: "http://127.0.0.1:8789/v0/management", token: "local", configPath: "/tmp/config.yaml" });

    await expect(client.accounts()).resolves.toEqual({
        codex: [],
        grok: [],
        kimi: [{ name: "kimi-user.json", label: "Kimi User" }],
        gemini: [],
    });
});
