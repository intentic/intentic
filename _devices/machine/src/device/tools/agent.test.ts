import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ScopeError } from "../policy.js";
import { AGENT_VERB, runAgentOp } from "./agent.js";

/* THE TWO THINGS ABOUT THIS TOOL THAT ARE DECISIONS RATHER THAN PLUMBING. The rest of it spawns a detached
 * process and tails a log, which is only true of a real machine; these two are what a wrong edit would break
 * silently, and both are checked before anything is started. */

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    sandboxRemove: "on",
    destructive: "on",
    ...overrides,
});

/* RESTART IS BARE `run`. The CLI's own residency reconcile stops whatever loop it finds before starting its
 * own, so `run` IS the restart; `run --stop` is the half that only stops, and a device that took that from a
 * button labelled "Restart agent" would go quiet until somebody walked over to it. */
test("the two ops map to the CLI verbs that actually perform them", () => {
    expect(AGENT_VERB).toEqual({ upgrade: "upgrade", restart: "run" });
});

/* SAME GATE AS TYPING IT, which is the honest one: this is a command the owner could run on their own machine,
 * and it touches no container, so it asks for "Run commands" rather than either sandbox switch. Refused BEFORE
 * the spawn, so a device with that switch off never starts an update it was not allowed to start. */
test("a device whose owner has not granted Run commands refuses before anything is started", async () => {
    const said: string[] = [];
    await expect(runAgentOp("upgrade", scopes({ shell: "off" }), (line) => said.push(line))).rejects.toBeInstanceOf(ScopeError);
    expect(said).toEqual([]);
});
