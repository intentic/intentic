import type { DeviceScopes } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import { ScopeError } from "../policy.js";
import { AGENT_VERB, runAgentOp } from "./agent.js";

/* THE TWO THINGS ABOUT THIS TOOL THAT ARE DECISIONS RATHER THAN PLUMBING. */

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "on",
    ...overrides,
});

/* RESTART IS BARE `run`, and the drop is the one op that is a task rather than a agent. */
test("every op maps to the CLI verb that actually performs it, and says whether that verb is meant to finish", () => {
    expect(AGENT_VERB).toEqual({
        upgrade: { argv: ["upgrade"], finishes: false },
        restart: { argv: ["run"], finishes: false },
        // Detached like the other two — its own reconcile kills the agent serving this socket — but it EXITS, and on the
        // path where nothing is unreachable it exits at once, which the settle check would otherwise call a crash.
        "forget-unreachable": { argv: ["device", "forget-unreachable"], finishes: true },
    });
});

/* SAME GATE AS TYPING IT, which is the honest one: this is a command the owner could run on their own machine, and it touches no container. */
test("a device whose owner has not granted Run commands refuses before anything is started", async () => {
    const said: string[] = [];
    await expect(runAgentOp("upgrade", scopes({ shell: "off" }), (line) => said.push(line))).rejects.toBeInstanceOf(ScopeError);
    expect(said).toEqual([]);
});
