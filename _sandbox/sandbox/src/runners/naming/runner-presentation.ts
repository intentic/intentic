import type { RunnerPresentation } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { opt } from "../../opt.js";
import type { HeldPresentation, PresentationStore } from "../../system/presentation/presentation-store.js";
import type { RunnerIdentity } from "../runner-identity.js";

/* WHAT A RUNNER CALLS ITSELF ON ITS MACHINE, AND WHOSE IT IS (2026-11-21). The machine lists every sandbox container by the
   name its daemon keeps in /history/presentation.json (ic's loopback.rs), and a runner kept none, so every runner on a
   machine read "Unnamed sandbox" with nothing to say which sandbox it works for. A runner has no platform row to be
   named by: its name is the one its parent gives it (runnerContract.present, on every connect and after a rename), kept
   in that same file with its parent's address and name beside it, where `ic sandbox list` reads them. */

// The copy a runner keeps: the name its parent gave it, and whose it is.
export const runnerPresentationOf = (identity: Pick<RunnerIdentity, "parentUrl">, told: RunnerPresentation, at: Date): HeldPresentation => ({
    name: told.name,
    at: at.toISOString(),
    runnerOf: { url: identity.parentUrl, ...opt("name", told.parentName) },
});

// What the parent told it, kept; written only when it changed (the store's own rule), so a reconnect that says the same
// rewrites nothing.
export const keepRunnerPresentation = async (
    store: PresentationStore,
    identity: Pick<RunnerIdentity, "parentUrl">,
    told: RunnerPresentation,
    now: () => Date = () => new Date(),
): Promise<void> => {
    await store.keep(runnerPresentationOf(identity, told, now()));
};

// On boot, before the parent has said anything: its id as its name, and its parent's address. Left alone when it already
// keeps one, which is the name its parent last gave it and may be a label this boot would otherwise overwrite until the
// link comes up.
export const seedRunnerPresentation = async (
    store: PresentationStore,
    identity: Pick<RunnerIdentity, "parentUrl" | "id">,
    now: () => Date = () => new Date(),
): Promise<void> => {
    const held = await store.read();
    if (held?.runnerOf?.url === identity.parentUrl) {
        return;
    }
    await keepRunnerPresentation(store, identity, { name: held?.name ?? identity.id }, now);
};
