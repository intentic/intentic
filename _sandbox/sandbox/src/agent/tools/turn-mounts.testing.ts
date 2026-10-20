import { unstubbed } from "@intentic/testing";
import type { BrowserRouter } from "../../browser/tools/browser-router.js";
import { testConfig } from "../../env.config.testing.js";
import { createTurnMounts, TURN_MOUNT_BASE } from "./turn-mounts.js";
import type { TurnMountDeps } from "./turn-tools.js";

// A turn's MCP mounts as the daemon composes them, over routers that never start a browser: every planned turn leases
// its mounts, and no suite built on this calls a browser tool. The real hub, so a suite reads what a turn mounted the
// way the door would. Typed by the turn's own TurnMountDeps: when a turn starts mounting something new, this stops
// compiling until it provides it (linkMounts reached every turn on 10-14 and failed 143 suites at run time instead).
export const testTurnMounts = (): TurnMountDeps => ({
    turnMounts: createTurnMounts({ baseUrl: () => `http://127.0.0.1:${testConfig.sandbox.port}${TURN_MOUNT_BASE}` }),
    browserRouters: () => unstubbed<BrowserRouter>("browserRouter", { close: () => undefined }),
    // No display in a suite: the desktop is never mounted.
    desktopServers: () => [],
    // No linked sandbox in a suite unless it mounts one itself (links/tests/link-mounts.integration.test.ts).
    linkMounts: () => [],
});
