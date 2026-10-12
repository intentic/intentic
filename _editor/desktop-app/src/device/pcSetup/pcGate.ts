import type { OnboardingCheck, OnboardingSetup } from "../../desktop";

// WHETHER A SETUP HANDED OVER CAN RUN ON THIS PC YET (2026-10-12). On Windows, Docker and WSL for this PC are set up by
// onboarding (onboarding.rs, the Agents page's "Set up this PC"), not by a sandbox's setup run. A setup handed over
// while this PC still needs that used to do nothing at all: the card offered only "Back" and "Dismiss", and the
// workspace page waited on a run that never started. Now it is parked (setup.ts `pcParked`), the card offers this PC's
// setup, and the parked setup carries on by itself once the PC is ready. Pure, given what the app knows.

/** `go`: run it now. `checking`: the PC check has not answered yet. `needsSetup`: this PC's own setup comes first. */
export type PcGate = `go` | `checking` | `needsSetup`;

export interface PcGateInput {
    /** The app's own OS (desktop.ts `DesktopInfo.os`), known before any window asks: `windows` is the only one gated. */
    readonly os: string | undefined;
    /** Whether Docker answered `docker info` the last time it was asked; undefined when it has not been. */
    readonly dockerReady: boolean | undefined;
    /** The onboarding check's state; undefined while it has not answered (it runs `ic docker prepare --dry-run`). */
    readonly check: OnboardingCheck[`state`] | undefined;
    /** This PC's own setup (onboarding.rs), as it last said; undefined where it has not been heard. */
    readonly pcSetup?: OnboardingSetup[`state`] | undefined;
}

export const pcGate = (input: PcGateInput): PcGate => {
    if (input.os !== `windows`) {
        return `go`;
    }
    // Docker answers, whoever installed it (the reader installed Docker Desktop by hand, 2026-10-12): the setup's own
    // checks take it from there, whatever a check made before that still says.
    if (input.dockerReady === true) {
        return `go`;
    }
    // This PC's own setup has just finished: what it was waited for is done, whatever a check made before it said.
    if (input.pcSetup === `ready`) {
        return `go`;
    }
    switch (input.check) {
        case undefined:
        case `checking`:
            // Deciding before the check has answered is how a setup went ahead on a PC that was not ready.
            return `checking`;
        case `needsSetup`:
            return `needsSetup`;
        // A PC that cannot run a sandbox, or a check that could not say: the setup's own prepare finds out what is
        // wrong and says so on its requirements card, which also offers a machine we host.
        case `ready`:
        case `cantRun`:
        case `unknown`:
            return `go`;
    }
};
