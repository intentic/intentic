import type { Services } from "../../../../composition.js";
import type { JournalledTurn } from "../../../../store/journals/turn-journal.js";
import { recoverCutTurns } from "../turn-resume.js";
import { type RestartResume, restartResume } from "./restart-resume-policy.js";

// The boot's recovery of the turns a restart cut (turn-resume.ts, interruptedTurnsInFlight), over what the journal holds
// now, for a suite that drives it at a clock of its own. With no answer given, the setting's alone decides, as a boot with
// no ask and no storm would.
export const resumeInterruptedTurns = async (services: Services, now: number = Date.now(), policy?: RestartResume, cost?: string): Promise<void> => {
    const left = (await services.turnJournal.list()).filter((entry): entry is JournalledTurn => entry.kind === "turn");
    await recoverCutTurns(services, left, policy ?? (await settingsResume(services)), now, cost);
};

// The answer a boot with no ask and no storm gives: the setting's alone.
export const settingsResume = async (services: Pick<Services, "sandboxSettings">): Promise<RestartResume> =>
    restartResume({ ownerAsked: false, storm: false, autoResumeOnRestart: (await services.sandboxSettings.get()).autoResumeOnRestart });
