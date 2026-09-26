import { type DeviceAgentOp, icForgetShapeArgs, icPowerArgs, icShapeArgs } from "@intentic/sandbox-contract";
import type { SandboxVerb } from "@intentic/ui";
import type { ShapeIntent } from "../shapeFlow";
import type { SyncCommand } from "./deviceOps";

// The line to type on the machine itself when the app's route to it is shut: a switch the device won't grant, an
// agent too old to carry the verb, a door that won't open. Same act the button does, run where only the person
// sitting at that machine can refuse it.
//
// `ic` and `intentic-machine` are spelled bare: both installers put their folder on the user's PATH, and the
// spellings below are the CLIs' guarded verb surface (ic's main.rs says so in as many words). No `-y` anywhere: a
// person at a terminal answers the CLI's own confirmation, which the agent has nobody to answer.

// Docker's name for a sandbox's container, the one prefix the machine agent and `ic` both write.
const CONTAINER = `intentic-sandbox-`;

// What `docker logs` tails, matching the agent's own default so the pasted line answers with what the pane would have.
// The agent reads it through `ic sandbox logs`; the typed line stays docker's, which answers on a machine whose ic
// predates that verb (the machine this line is printed for is often one whose agent is behind).
const LOG_LINES = 200;

// The verbs `ic` owns: moving a sandbox between images, and its power, since a start or restart through ic applies
// the shape saved for the next restart and a bare `docker restart` would not.
const IC_VERB: Partial<Record<SandboxVerb, string>> = { update: `update`, rollback: `rollback`, remove: `remove` };
const POWER = new Set<SandboxVerb>([`start`, `stop`, `restart`]);

/**
 * The command that does this verb to this sandbox by hand, or undefined for a verb with no single-line equivalent.
 * `resources` is the form's answer: a whole shape with when it takes effect, or forgetting the one saved, spelled by
 * the contract's own `ic` argv so this line and the machine agent's run cannot differ.
 */
export const sandboxFallback = (verb: SandboxVerb, slug: string, intent?: ShapeIntent): string | undefined => {
    const ic = IC_VERB[verb];
    if (ic !== undefined) {
        return `ic sandbox ${ic} ${slug}`;
    }
    if (POWER.has(verb)) {
        return `ic ${icPowerArgs(verb as `start` | `stop` | `restart`, slug).join(` `)}`;
    }
    if (verb === `logs`) {
        return `docker logs --tail ${LOG_LINES} ${CONTAINER}${slug}`;
    }
    if (intent === undefined) {
        return undefined;
    }
    return `ic ${(`forget` in intent ? icForgetShapeArgs(slug) : icShapeArgs(slug, intent.shape, intent.when)).join(` `)}`;
};

/**
 * The command that does this to the machine's own agent by hand. `restart` is bare `run`, not a stop and a start:
 * the loop it finds is stopped by the one it starts (the agent's own AGENT_VERB says the same).
 */
const AGENT_COMMAND: Record<DeviceAgentOp, string> = {
    upgrade: `upgrade`,
    restart: `run`,
    "forget-unreachable": `device forget-unreachable`,
};

export const agentFallback = (op: DeviceAgentOp): string => `intentic-machine ${AGENT_COMMAND[op]}`;

/**
 * The command that removes a runner by hand. Only removal: starting one redeems a pairing the parent sandbox mints,
 * and a runner's settings have no verb of their own.
 */
export const runnerFallback = (op: "create" | "remove" | "update", name: string): string | undefined =>
    op === `remove` ? `ic runner remove ${name}` : undefined;

// The sync half of the CLI, verb for verb. `sync-install` is absent on purpose: enrolling needs a one-time pairing
// token this card mints, so a line printed here would already be spent by the time anyone typed it.
const SYNC_VERB: Partial<Record<SyncCommand, string>> = {
    "sync-pause": `sync pause`,
    "sync-resume": `sync resume`,
    "sync-unpair": `sync uninstall`,
    "sync-clean": `sync clean`,
    "mirror-off": `sync mirror off`,
    "mirror-on": `sync mirror on`,
    "mirror-ignore": `sync mirror ignore`,
    "mirror-unignore": `sync mirror unignore`,
};

/**
 * The command that does this to one machine's file sync by hand, or undefined for the one that can't be typed.
 * A pairing named narrows it to that sandbox; without one the verb acts on every pairing, exactly as the bare
 * button does. A port narrows it further, and only the two per-port mirror switches ever carry one.
 */
export const syncFallback = (command: SyncCommand, sandboxId: string | undefined, port?: number): string | undefined => {
    const verb = SYNC_VERB[command];
    if (verb === undefined) {
        return undefined;
    }
    return `intentic-machine ${verb}${sandboxId === undefined ? `` : ` --sandbox ${sandboxId}`}${port === undefined ? `` : ` --port ${port}`}`;
};
