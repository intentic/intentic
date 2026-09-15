import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ScopeError } from "../policy.js";
import { AGENT_VERB, runAgentOp } from "./agent.js";

/* THE TWO THINGS ABOUT THIS TOOL THAT ARE DECISIONS RATHER THAN PLUMBING. */

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "on",
    ...overrides,
});

/* RESTART IS BARE `run`. */
test("the two ops map to the CLI verbs that actually perform them", () => {
    expect(AGENT_VERB).toEqual({ upgrade: "upgrade", restart: "run" });
});

/* SAME GATE AS TYPING IT, which is the honest one: this is a command the owner could run on their own machine, and it touches no container. */
test("a device whose owner has not granted Run commands refuses before anything is started", async () => {
    const said: string[] = [];
    await expect(runAgentOp("upgrade", scopes({ shell: "off" }), (line) => said.push(line))).rejects.toBeInstanceOf(ScopeError);
    expect(said).toEqual([]);
});
