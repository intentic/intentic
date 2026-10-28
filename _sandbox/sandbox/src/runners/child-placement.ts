import type { RunnerSummary } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { type FleetLoad, placeFanOut } from "./runner-scheduler.js";

/* WHERE A SPAWNED CHILD RUNS, AND WHAT ITS PARENT IS TOLD. A machine the parent names is a promise to whoever asked for
   it: the child runs there, or the spawn is refused before it takes a seat, with the reason and the spawn that would work.
   It used to fall back in silence (the privacy shield, an offline or misspelled runner) or start there and fail late with
   a sign-in message that was not true (a Codex or Devin child, whose credential never leaves this sandbox), and on
   2026-10-28 an orchestrator was left to guess from a container hostname whether its children had run where it said. A
   child nobody placed goes where the fleet has room, and the parent hears where. */

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
}

export type ChildPlacementVerdict =
    | { readonly kind: "here"; readonly note?: string }
    | { readonly kind: "runner"; readonly runner: string; readonly note: string }
    | { readonly kind: "refused"; readonly message: string };

const HERE = `on: "here"`;

const known = (runners: readonly RunnerSummary[]): string =>
    runners.length === 0 ? "This sandbox has no runners." : `Its runners: ${runners.map((runner) => `"${runner.id}"${runner.online ? "" : " (offline)"}`).join(", ")}.`;

// Why a named machine cannot take this child, or undefined when it can.
const unmet = (ask: ChildPlacementAsk, runner: string, runners: readonly RunnerSummary[]): string | undefined => {
    const summary = runners.find((entry) => entry.id === runner);
    if (summary === undefined) {
        return `There is no runner named "${runner}". ${known(runners)} Spawn it on one of them, or ${HERE}.`;
    }
    if (!summary.online || summary.facts === undefined) {
        return `The runner "${runner}" is offline. Wake that machine and spawn again, or spawn it ${HERE}.`;
    }
    if (ask.shieldHolds) {
        return (
            `The privacy shield keeps ${ask.providerLabel} in this sandbox: on "${runner}" it would call ${ask.providerLabel} from that machine, ` +
            `where the shield cannot mask what it sends. Spawn it ${HERE}, or ask the owner to trust ${ask.providerLabel} in Privacy & safety.`
        );
    }
    if (!ask.travels) {
        return ask.claudeCodeLoop
            ? `${ask.providerLabel} in its own harness cannot run on "${runner}": its sign-in stays in this sandbox. Spawn it with ` +
                  `harness: "claude-code" to run it on "${runner}" through this sandbox's account, or ${HERE}.`
            : `${ask.providerLabel} cannot run on "${runner}": its sign-in stays in this sandbox and no harness carries it there. Spawn it ${HERE}.`;
    }
    return undefined;
};

/** Where a child goes: the machine it was asked onto, the fleet's pick, or a refusal naming the spawn that would work. */
export const placeChild = (ask: ChildPlacementAsk, runners: readonly RunnerSummary[], load: FleetLoad): ChildPlacementVerdict => {
    if (ask.on === "here") {
        return { kind: "here" };
    }
    if (ask.on !== undefined) {
        const refusal = unmet(ask, ask.on, runners);
        return refusal === undefined ? { kind: "runner", runner: ask.on, note: `Running on the runner "${ask.on}".` } : { kind: "refused", message: refusal };
    }
    // Nobody placed it: the fleet's pick among the machines that can take it, and here for one the shield keeps home.
    const picked = ask.shieldHolds ? undefined : placeFanOut(runners, load, { travels: ask.travels }).runner;
    if (picked !== undefined) {
        return { kind: "runner", runner: picked, note: `Running on the runner "${picked}", which had room.` };
    }
    // Said only where a runner was there to be picked, so a fleetless sandbox's notes stay as they were.
    return runners.some((runner) => runner.online) ? { kind: "here", note: "Running here, in this sandbox." } : { kind: "here" };
};

/** Where the child's turn is dispatched, as runChildTurn takes it. */
export const dispatchOf = (verdict: ChildPlacementVerdict): "local" | { readonly runner: string } =>
    verdict.kind === "runner" ? { runner: verdict.runner } : "local";

/** The placement its turn input records, absent for here. */
export const placementOf = (verdict: ChildPlacementVerdict): { readonly kind: "runner"; readonly id: string } | undefined =>
    verdict.kind === "runner" ? { kind: "runner", id: verdict.runner } : undefined;
