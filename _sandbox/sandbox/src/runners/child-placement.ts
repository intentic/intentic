import type { FleetMachine, MachineLoad } from "@intentic/sandbox-contract/schemas/offload";
import type { RunnerSummary } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { suggestionFor } from "./fleet-advice.js";

/* WHERE A SPAWNED CHILD RUNS, AND WHAT ITS PARENT IS TOLD. A machine the parent names is a promise to whoever asked for
   it: the child runs there, or the spawn is refused before it takes a seat, with the reason and the spawn that would work.
   It used to fall back in silence (the privacy shield, an offline or misspelled runner) or start there and fail late with
   a sign-in message that was not true (a Codex or Devin child, whose credential never leaves this sandbox), and on
   2026-10-28 an orchestrator was left to guess from a container hostname whether its children had run where it said.

   A child nobody placed is judged like a new session (fleet-advice.ts): it stays here while this sandbox is calm, which
   costs no sync and keeps every tool it has here, and otherwise goes to the runner strictly better off by standing and by
   headroom. The refusals point back at leaving `on` out, never at pinning `"here"`: on 2026-11-09, 46 of 114 spawns
   named "here", whole fan-outs at a time, after a refusal had taught their parent that pinning was the way through. */

export interface ChildPlacementAsk {
    // `on` as the parent gave it: a runner's id, "here", or undefined for the fleet's pick.
    readonly on: string | undefined;
    // The provider's name as people read it ("Codex"), for the sentences below.
    readonly providerLabel: string;
    // Whether this provider and harness may take its credential to a runner (credentialsTravel).
    readonly travels: boolean;
    // Whether the provider also runs in the Claude Code harness, whose credential does travel.
    readonly claudeCodeLoop: boolean;
    // Whether the privacy shield keeps this provider in this sandbox.
    readonly shieldHolds: boolean;
    // How heavy the child's task reads (subagent-sizing.ts), asked only when runner room is contested; absent reads heavy.
    readonly weight?: ChildWeight | undefined;
}

// Heavy work builds, tests or type-checks; light work reads, searches and writes prose.
export type ChildWeight = "light" | "heavy";

/** The machines a child nobody placed could go to, measured with what this daemon placed but cannot see running yet. */
export interface ChildFleet {
    readonly here: MachineLoad;
    // Every runner, judged for this child (fleetMachine with its fit): the session advice's own verdicts.
    readonly machines: readonly FleetMachine[];
}

export type ChildPlacementVerdict =
    | { readonly kind: "here"; readonly note?: string }
    | { readonly kind: "runner"; readonly runner: string; readonly note: string }
    | { readonly kind: "refused"; readonly message: string };

// What every refusal offers first: the spawn without a machine, which places it wherever it can run.
const LEAVE_IT_OUT = "leave `on` out and it is placed where it can run";

// Free slots at or below which the best runner's room is contested: a light child keeps them for a heavy sibling.
const CONTESTED_SLOTS = 2;

const known = (runners: readonly RunnerSummary[]): string =>
    runners.length === 0 ? "This sandbox has no runners." : `Its runners: ${runners.map((runner) => `"${runner.id}"${runner.online ? "" : " (offline)"}`).join(", ")}.`;

// Why a named machine cannot take this child, or undefined when it can.
const unmet = (ask: ChildPlacementAsk, runner: string, runners: readonly RunnerSummary[]): string | undefined => {
    const summary = runners.find((entry) => entry.id === runner);
    if (summary === undefined) {
        return `There is no runner named "${runner}". ${known(runners)} Name one of them, or ${LEAVE_IT_OUT}.`;
    }
    if (!summary.online || summary.facts === undefined) {
        return `The runner "${runner}" is offline. ${capitalised(LEAVE_IT_OUT)}, or wake that machine and spawn again.`;
    }
    if (ask.shieldHolds) {
        return (
            `The privacy shield keeps ${ask.providerLabel} in this sandbox: on "${runner}" it would call ${ask.providerLabel} from that machine, ` +
            `where the shield cannot mask what it sends. Leave \`on\` out and it runs here, or ask the owner to trust ${ask.providerLabel} in Privacy & safety.`
        );
    }
    if (!ask.travels) {
        return ask.claudeCodeLoop
            ? `${ask.providerLabel} in its own harness cannot run on "${runner}": its sign-in stays in this sandbox. Spawn it with ` +
                  `harness: "claude-code" to run it on "${runner}" through this sandbox's account, or leave \`on\` out and it runs here.`
            : `${ask.providerLabel} cannot run on "${runner}": its sign-in stays in this sandbox and no harness carries it there. Leave \`on\` out and it runs here.`;
    }
    return undefined;
};

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

// The runner a child nobody placed would go to, with its verdict, or undefined when it stays here.
const fleetPick = (fleet: ChildFleet): { readonly machine: FleetMachine; readonly load: MachineLoad } | undefined => {
    const picked = suggestionFor("auto", fleet.here, fleet.machines);
    const machine = picked === undefined ? undefined : fleet.machines.find((entry) => entry.runner === picked.runner);
    return machine?.load === undefined ? undefined : { machine, load: machine.load };
};

// "Running on omen (runner "irt_…")": the machine first, since that is the word the owner knows; the id for a later `on`.
const runnerWords = (machine: FleetMachine): string => (machine.name === machine.runner ? `the runner "${machine.runner}"` : `${machine.name} (runner "${machine.runner}")`);

/**
 * Whether the room a child would take is contested: this sandbox is busy but not full, so a light child still runs here,
 * and the runner it would go to has no more than CONTESTED_SLOTS slots left. Only then is its weight worth asking.
 */
export const roomContested = (ask: ChildPlacementAsk, fleet: ChildFleet | undefined): boolean => {
    if (ask.on !== undefined || ask.shieldHolds || !ask.travels || fleet === undefined || fleet.here.standing !== "busy") {
        return false;
    }
    const pick = fleetPick(fleet);
    return pick !== undefined && pick.load.slots - pick.load.agents <= CONTESTED_SLOTS;
};

/** Where a child goes: the machine it was asked onto, the fleet's pick, or a refusal naming the spawn that would work. */
export const placeChild = (ask: ChildPlacementAsk, runners: readonly RunnerSummary[], fleet: ChildFleet | undefined): ChildPlacementVerdict => {
    if (ask.on === "here") {
        return { kind: "here" };
    }
    if (ask.on !== undefined) {
        const refusal = unmet(ask, ask.on, runners);
        return refusal === undefined ? { kind: "runner", runner: ask.on, note: `Running on the runner "${ask.on}".` } : { kind: "refused", message: refusal };
    }
    // Said only where a runner was there to be picked, so a fleetless sandbox's notes stay as they were.
    const anyOnline = runners.some((runner) => runner.online);
    if (ask.shieldHolds || !ask.travels || fleet === undefined) {
        return anyOnline ? { kind: "here", note: "Running here, in this sandbox." } : { kind: "here" };
    }
    const pick = fleetPick(fleet);
    if (pick === undefined) {
        const why = fleet.here.standing === "calm" ? "which has room" : "since no runner had more room";
        return anyOnline ? { kind: "here", note: `Running here, in this sandbox, ${why}.` } : { kind: "here" };
    }
    if (ask.weight === "light" && roomContested(ask, fleet)) {
        return { kind: "here", note: `Running here, in this sandbox: its task reads as light work, and ${pick.machine.name}'s last free slots are kept for heavier work.` };
    }
    return { kind: "runner", runner: pick.machine.runner, note: `Running on ${runnerWords(pick.machine)}, which had more room than this sandbox.` };
};

/** Where the child's turn is dispatched, as runChildTurn takes it. */
export const dispatchOf = (verdict: ChildPlacementVerdict): "local" | { readonly runner: string } =>
    verdict.kind === "runner" ? { runner: verdict.runner } : "local";

/** The placement its turn input records, absent for here. */
export const placementOf = (verdict: ChildPlacementVerdict): { readonly kind: "runner"; readonly id: string } | undefined =>
    verdict.kind === "runner" ? { kind: "runner", id: verdict.runner } : undefined;
