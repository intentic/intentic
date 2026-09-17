import type { DeviceAgentOp } from "@intentic/sandbox-contract";
import type { ResourcesAsk, SandboxVerb } from "@intentic/ui";
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
const LOG_LINES = 200;

// The verbs `ic` owns because they move a sandbox between images, and the ones docker alone can do because the
// container is already built and only its power state changes.
const IC_VERB: Partial<Record<SandboxVerb, string>> = { update: `update`, rollback: `rollback`, remove: `remove` };
const DOCKER_VERB: Partial<Record<SandboxVerb, string>> = { start: `start`, stop: `stop`, restart: `restart` };

// A cap's flag value, spelled the way `ic sandbox reshape` takes it: a number as `<n>g`/`<n>`, and null as ic's own
// `default` (back to the share derived from the machine).
const capFlag = (value: number | null | undefined, spell: (value: number) => string): string | undefined =>
    value === undefined ? undefined : value === null ? `default` : spell(value);

const switchFlag = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : value ? `on` : `off`);

// The reshape the user just asked for, as flags. Undefined when the ask changed nothing — ic refuses that too, so a
// line that carried it would only fail differently.
const reshapeFlags = (ask: ResourcesAsk | undefined): string | undefined => {
    const given = (
        [
            [`--memory`, capFlag(ask?.memoryGib, (gib) => `${gib}g`)],
            [`--cpus`, capFlag(ask?.cpus, String)],
            [`--privileged`, switchFlag(ask?.privileged)],
            [`--gpus`, switchFlag(ask?.gpu)],
        ] as const
    ).flatMap(([flag, value]) => (value === undefined ? [] : [flag, value]));
    return given.length === 0 ? undefined : given.join(` `);
};

/** The command that does this verb to this sandbox by hand, or undefined for a verb with no single-line equivalent. */
export const sandboxFallback = (verb: SandboxVerb, slug: string, resources?: ResourcesAsk): string | undefined => {
    const ic = IC_VERB[verb];
    if (ic !== undefined) {
        return `ic sandbox ${ic} ${slug}`;
    }
    const docker = DOCKER_VERB[verb];
    if (docker !== undefined) {
        return `docker ${docker} ${CONTAINER}${slug}`;
    }
    if (verb === `logs`) {
        return `docker logs --tail ${LOG_LINES} ${CONTAINER}${slug}`;
    }
    const flags = reshapeFlags(resources);
    return flags === undefined ? undefined : `ic sandbox reshape ${slug} ${flags}`;
};

/**
 * The command that does this to the machine's own agent by hand. `restart` is bare `run`, not a stop and a start:
 * the loop it finds is stopped by the one it starts (the agent's own AGENT_VERB says the same).
 */
export const agentFallback = (op: DeviceAgentOp): string => `intentic-machine ${op === `upgrade` ? `upgrade` : `run`}`;

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
