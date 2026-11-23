import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_FLEET_CONVERSATION_HEADER, RUNNER_SUBAGENTS_DOOR_HEADER } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { unstubbed } from "@intentic/testing";
import { createApp } from "../../app.js";
import { testConfig } from "../../env.config.testing.js";
import { services } from "../../harness/route-services.testing.js";
import type { RunnerStore } from "../runner-peer.js";

/* The subagents door is reached through the app itself: createApp registers every raw route from the generated table
   (app-raw-routes.ts, scripts/write-indexes.mjs), so a door the table lost would 404 every call a runner forwards,
   whatever the door does (2026-11-23: the regenerated table once lacked it, and a suite mounting the door by hand could
   not see it). The door's behaviour is runner-subagents.integration.test.ts. */

test("the app serves the runners' subagents door from its own raw-route table", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "runner-subagents-wiring-"));
    try {
        const runners = unstubbed<RunnerStore>("runners", {
            verify: async (token) => (token === "omen-token" ? { kind: "enrolled", id: "omen", card: "runner-omen" } : { kind: "unknown" }),
        });
        const app = createApp(services({ config: { ...testConfig, historyRoot }, runners }));
        const response = await app.request("/system/runners/subagents/spawn", {
            method: "POST",
            headers: { authorization: "Bearer omen-token", "content-type": "application/json", [RUNNER_FLEET_CONVERSATION_HEADER]: "convo-nowhere-1abc" },
            body: "{}",
        });
        // The door's own refusal, marked as the door's: an app without the route answers a bare 404 with no such header.
        expect(response.status).toBe(404);
        expect(response.headers.get(RUNNER_SUBAGENTS_DOOR_HEADER)).toBe("1");
        expect(await response.json()).toMatchObject({ ok: false, placed: false });
    } finally {
        rmSync(historyRoot, { recursive: true, force: true });
    }
});
