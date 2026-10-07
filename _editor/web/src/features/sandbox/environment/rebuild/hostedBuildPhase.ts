import type { HostedBuildState } from "@intentic/api-contract";

// Where a hosted sandbox's environment build stands for the recipe waiting to be built, read once for every surface that
// speaks of it (the Environment card's button, the attention row, the Menu's own button), so none of them says
// "rebuild" while another says "building".
//
// THE SWAP IS GIVEN A WINDOW. A built image the platform has pointed the sandbox at is a restart in progress, but only
// for a few minutes: `built` is a resting state, and while the sandbox still reports the old image the card used to say
// "restarting onto the new image" for as long as anyone looked, with no button, under a banner asking for a rebuild.
// Past the window the build is `stalled`, and the button comes back.

// How long after a build finishes its swap is still the explanation; the same five minutes the restart ledger gives it
// (useHostedBuild.ts `SWAP_WINDOW_MS`).
export const SWAP_WINDOW_MS = 5 * 60_000;

export type HostedBuildPhase =
    // No build of this recipe: the button.
    | { readonly kind: `idle` }
    | { readonly kind: `building`; readonly since: number }
    // Built and pointed at, the sandbox not back on it yet.
    | { readonly kind: `switching` }
    // Built a while ago, yet the sandbox still reports the old image: the button again, saying so.
    | { readonly kind: `stalled`; readonly builtAt: number }
    | { readonly kind: `failed`; readonly error: string | undefined; readonly log: string | undefined };

const at = (iso: string | undefined): number | undefined => {
    const parsed = iso === undefined ? Number.NaN : Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : undefined;
};

// `applied` is the image the platform last pointed the sandbox at; `hash` the recipe the daemon says is waiting.
export const hostedBuildPhase = (build: HostedBuildState | undefined, applied: string | undefined, hash: string, now: number): HostedBuildPhase => {
    if (build === undefined || build.hash !== hash) {
        return { kind: `idle` };
    }
    if (build.state === `building`) {
        return { kind: `building`, since: at(build.startedAt) ?? now };
    }
    if (build.state === `failed`) {
        return { kind: `failed`, error: build.error, log: build.log };
    }
    const finished = at(build.finishedAt);
    if (applied === hash && finished !== undefined && now - finished < SWAP_WINDOW_MS) {
        return { kind: `switching` };
    }
    return { kind: `stalled`, builtAt: finished ?? at(build.startedAt) ?? now };
};

// Whether the platform is at work on it: nothing to press, nothing owed by the owner.
export const buildUnderWay = (phase: HostedBuildPhase): boolean => phase.kind === `building` || phase.kind === `switching`;
