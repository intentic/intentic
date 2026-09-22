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

/* RESTART IS BARE `run`, and every op is a task: a run that finds nothing to do exits at once, and that is no crash. */
test("every op maps to the CLI verb that actually performs it", () => {
    expect(AGENT_VERB).toEqual({
        // The whole machine, whichever side was asked: the command itself reaches the rest of the PC.
        upgrade: ["upgrade"],
        restart: ["run"],
        "forget-unreachable": ["device", "forget-unreachable"],
    });
});

/* SAME GATE AS TYPING IT, which is the honest one: this is a command the owner could run on their own machine, and it touches no container. */
test("a device whose owner has not granted Run commands refuses before anything is started", async () => {
    const said: string[] = [];
    await expect(runAgentOp("upgrade", scopes({ shell: "off" }), (line) => said.push(line))).rejects.toBeInstanceOf(ScopeError);
    expect(said).toEqual([]);
});
