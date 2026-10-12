import { t } from "@intentic/ui/i18n";
import type { DockerOutcome } from "../desktop";

// WHAT A START OF THE ENGINE CAME TO, in the Docker card's own two sentences (DockerCard.vue): what happened, then what
// is left for a person to do. Pure, so a press made somewhere the card is not (a folder window's card, host.ts) says the
// same as the card on This computer, and each ending is tested by value (dockerWords.test.ts).

export interface DockerWords {
    readonly heading: string;
    readonly body: string;
}

export interface DockerEngineFacts {
    /** Intentic's own engine (engine.ts `onOurEngine`): no Docker Desktop to open, sign in to or quit. */
    readonly ours: boolean;
    /** A refused engine means a sign-out on Windows, a group elsewhere. */
    readonly windows: boolean;
}

const oursEnding = (outcome: DockerOutcome | undefined): DockerWords => {
    switch (outcome) {
        case `wouldNotStart`:
            return { heading: t(`desktop.docker.oursWouldntStart`), body: t(`desktop.docker.oursCheckAgain`) };
        case `tookTooLong`:
            return { heading: t(`desktop.docker.oursTakingLong`), body: t(`desktop.docker.oursCheckAgain`) };
        case `broken`:
            return { heading: t(`desktop.docker.oursBroken`), body: t(`desktop.docker.oursRestartComputer`) };
        default:
            return { heading: t(`desktop.docker.oursIsntRunning`), body: t(`desktop.docker.oursCheckAgain`) };
    }
};

/** The card's words for a start that has ended as `outcome`, or for no start yet (`undefined`). */
export const dockerEnding = (outcome: DockerOutcome | undefined, engine: DockerEngineFacts): DockerWords => {
    if (engine.ours) {
        return oursEnding(outcome);
    }
    switch (outcome) {
        case `notInstalled`:
            return { heading: t(`desktop.docker.dockerIsntOnThisComputer`), body: t(`desktop.docker.nothingToStartUntilInstalled`) };
        case `wouldNotStart`:
            return { heading: t(`desktop.docker.dockerWouldntStart`), body: t(`desktop.docker.tryOpeningItYourself`) };
        case `notAllowed`:
            return engine.windows
                ? { heading: t(`desktop.docker.accountNotAllowedWindows`), body: t(`desktop.docker.signOutAndBackIn`) }
                : { heading: t(`desktop.docker.accountNotAllowed`), body: t(`desktop.docker.addToDockerGroup`) };
        case `tookTooLong`:
            return { heading: t(`desktop.docker.dockerHasntFinishedStarting`), body: t(`desktop.docker.mayBeWaitingForYou`) };
        // Up, and answering every request with an error: a wait would only have run out the clock on it.
        case `broken`:
            return { heading: t(`desktop.docker.engineIsBroken`), body: t(`desktop.docker.quitAndOpenAgain`) };
        // Nothing has been tried yet: the engine is down and this screen was reached before a start began.
        default:
            return { heading: t(`desktop.docker.dockerIsntRunning`), body: t(`desktop.docker.tryOpeningItYourself`) };
    }
};

/** The same ending as one line, for a place with room for a sentence and no card: the heading, then what to do. */
export const dockerEndingLine = (outcome: DockerOutcome | undefined, engine: DockerEngineFacts): string => {
    const { heading, body } = dockerEnding(outcome, engine);
    return `${heading}. ${body}`;
};
