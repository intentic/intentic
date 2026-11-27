import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayCtx } from "@intentic/connector-runtime";
import { unstubbed } from "@intentic/testing";
import { socketModeAsleepNotice } from "./app-manifest.js";
import { TOLD_FILE, tellSocketModeAsleep } from "./socket-notice.js";

// The once-report a hosted sandbox's Socket Mode app gets, over a temporary state directory and a gateway context
// whose daemon records each failure it is told.

const REQUEST_URL = "https://sandbox.example/door/intentic.slack/events?wake=s3cret";

let stateDir = "";
beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "slack-socket-notice-"));
});
afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
});

const gatewayCtx = () => {
    const told: string[] = [];
    const asked: string[] = [];
    const ctx = unstubbed<GatewayCtx>("ctx", {
        api: unstubbed<GatewayCtx["api"]>("api", {
            stateDir,
            sleep: unstubbed<GatewayCtx["api"]["sleep"]>("sleep", {
                wakeUrl: async (route) => {
                    asked.push(route);
                    return REQUEST_URL;
                },
            }),
        }),
        daemon: unstubbed<GatewayCtx["daemon"]>("daemon", { failure: async (detail) => void told.push(detail) }),
    });
    return { ctx, told, asked };
};

test("an app on Socket Mode is told once, with its Request URL, however often the sandbox wakes", async () => {
    const { ctx, told, asked } = gatewayCtx();
    await tellSocketModeAsleep(ctx, "xapp-1-A1-first");
    await tellSocketModeAsleep(ctx, "xapp-1-A1-first");
    expect(asked).toEqual(["events"]);
    expect(told).toEqual([socketModeAsleepNotice(REQUEST_URL)]);
    // A later process reads who was told from disk, not from its own memory.
    const restarted = gatewayCtx();
    await tellSocketModeAsleep(restarted.ctx, "xapp-1-A1-first");
    expect(restarted.told).toEqual([]);
});

test("another app is told for itself, and no token is written down", async () => {
    const { ctx, told } = gatewayCtx();
    await tellSocketModeAsleep(ctx, "xapp-1-A1-first");
    await tellSocketModeAsleep(ctx, "xapp-1-A2-second");
    expect(told).toHaveLength(2);
    expect(await readFile(join(stateDir, TOLD_FILE), "utf8")).not.toContain("xapp-");
});
