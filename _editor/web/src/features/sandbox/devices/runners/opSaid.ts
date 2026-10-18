import { t } from "@intentic/ui/i18n";
import { setupSaid } from "../sync/syncSetup";
import type { SyncCommand } from "./deviceOps";

// WHAT A PRESS ON A MACHINE SAYS BACK, AS A LINE UNDER THE ROW. A machine answers with its CLI's whole plain stream:
// `intentic: resuming file sync…` narration, whatever Mutagen printed about its sessions, and a verdict naming every
// pairing key with its folder path. Printed as it came, a click on Resume left a paragraph of that under the row, and
// none of it said more than the button's flipped label already did. So the line is the app's own sentence, and the
// machine's words wait behind Details for anyone who wants them.

/** A press's answer, under the key of where it was pressed. */
export interface OpOutcome extends OpSaid {
    readonly key: string;
}

/** One press's answer: the sentence the line shows, and the machine's own output behind Details when it says more. */
export interface OpSaid {
    readonly message: string;
    readonly detail?: string;
    /** The machine took the press and had nothing to do (no session to resume, a pairing that only mirrors ports). */
    readonly idle?: boolean;
}

// The machine's own sentences for a press that changed nothing (sync/commands.ts fileSyncSwitch, pairingCommand).
const NOTHING_DONE = /\bnothing (?:was|to)\b|\bno file[- ]sync\b|\bonly mirrors? ports\b|\bno sandbox is paired\b/i;

const NARRATION = /^intentic:\s*/;

const withDetail = (message: string, raw: string): OpSaid => (raw === `` || raw === message ? { message } : { message, detail: raw });

/** A line already chosen by its caller (setup's, syncSetup.ts), with the machine's whole output behind it. */
export const saidOver = (message: string, output: string): OpSaid => withDetail(message, output.trim());

/**
 * A switch's answer: `headline` (the app's sentence for the switch having worked) unless the machine's verdict, its
 * last `intentic:` line, says it did nothing, which is then the line itself, so the page never claims a resume that
 * didn't happen.
 */
export const switchSaid = (headline: string, output: string): OpSaid => {
    const raw = output.trim();
    const verdict = raw
        .split(/\r?\n/)
        .filter((line) => NARRATION.test(line))
        .map((line) => line.replace(NARRATION, ``).trim())
        .findLast((line) => line !== ``);
    if (verdict !== undefined && NOTHING_DONE.test(verdict)) {
        return { ...withDetail(verdict, raw), idle: true };
    }
    return withDetail(headline, raw);
};

/** An answer that is already a verdict on its first line (a container verb's): that line, and the rest behind Details. */
export const verdictSaid = (output: string): OpSaid => {
    const raw = output.trim();
    const first = raw.split(/\r?\n/).find((line) => line.trim() !== ``)?.trim() ?? ``;
    return withDetail(first, raw);
};

// The line a switch leaves under the row once it has worked, in the app's words; the machine's are behind Details.
// Setup keeps its own reading of the CLI's answer (syncSetup.ts), which can name something about the folder.
const syncDone = (command: Exclude<SyncCommand, "sync-install">): string =>
    ({
        "mirror-off": t(`sandbox.deviceOps.doneMirrorOff`),
        "mirror-on": t(`sandbox.deviceOps.doneMirrorOn`),
        "mirror-ignore": t(`sandbox.deviceOps.doneIgnore`),
        "mirror-unignore": t(`sandbox.deviceOps.doneUnignore`),
        "sync-pause": t(`sandbox.deviceOps.donePause`),
        "sync-resume": t(`sandbox.deviceOps.doneResume`),
        "sync-unpair": t(`sandbox.deviceOps.doneUnpair`),
        "sync-clean": t(`sandbox.deviceOps.doneClean`),
    })[command];

export const syncSaid = (command: SyncCommand, output: string): OpSaid =>
    command === `sync-install` ? saidOver(setupSaid(output), output) : switchSaid(syncDone(command), output);
