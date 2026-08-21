import type { ActivityStatus } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolveConnections } from "./activity.routes.js";

type Conn = ActivityStatus["connections"][number];
const conn = (gateway: Conn["gateway"], capabilityId = "discord"): Conn => ({ capabilityId, provider: "discord", gateway });
const ERROR = "Discord rejected the bot token: check the capability's botToken";

// idle = no enabled listener automation: the gateway is up but deliberately not connecting, so every card reads
// "idle" and no login error is surfaced (there was no login attempt to fail).
test("idle overrides every pushed gateway state and drops lastError", () => {
    expect(resolveConnections([conn("disconnected"), conn("ready", "d2")], true, ERROR)).toEqual([
        { capabilityId: "discord", provider: "discord", gateway: "idle" },
        { capabilityId: "d2", provider: "discord", gateway: "idle" },
    ]);
});

// With an enabled automation, only a genuinely-down connection carries the error; a connected/connecting card
// must not inherit a stale system-error from the recent-log scan.
test("lastError rides only a disconnected connection", () => {
    const resolved = resolveConnections([conn("disconnected"), conn("ready", "d2"), conn("connecting", "d3")], false, ERROR);
    expect(resolved[0]).toEqual({ capabilityId: "discord", provider: "discord", gateway: "disconnected", lastError: ERROR });
    expect(resolved[1]).toEqual({ capabilityId: "d2", provider: "discord", gateway: "ready" });
    expect(resolved[2]).toEqual({ capabilityId: "d3", provider: "discord", gateway: "connecting" });
});

// A down connection with nothing in the error log stays a bare "Not listening": no lastError key at all.
test("a disconnected connection with no recorded error carries no lastError", () => {
    const resolved = resolveConnections([conn("disconnected")], false, undefined);
    expect(resolved).toEqual([{ capabilityId: "discord", provider: "discord", gateway: "disconnected" }]);
    // Absent, not present-and-undefined: the browser renders the key's presence.
    expect(resolved.flatMap((row) => Object.keys(row))).not.toContain("lastError");
});
