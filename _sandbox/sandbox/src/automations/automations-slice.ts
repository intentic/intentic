import { join } from "node:path";
import type { Logger } from "pino";
import { fileThreadSessionsStore, threadSessionsDocument, type ThreadSessionsStore } from "../sessions/thread-sessions.js";
import { automationRunsDocument, automationsDocument, type AutomationsStore, fileAutomationsStore } from "./automations-store.js";
import { fileHeldWakesStore, type HeldWakesStore } from "./held-wakes-store.js";
import { fileScheduleCoverageStore, scheduleCoverageDocument, type ScheduleCoverageStore } from "./schedule-coverage.js";
import { fileSendersStore, sendersDocument, type SendersStore } from "./senders-store.js";

// Automations and what a fire carries: held wakes, threads and senders.
export interface AutomationsSlice {
    // Scheduled agent wake-ups; run history is a separate ledger joined on read, so callers see one store.
    readonly automations: AutomationsStore;
    // Wakes from requireApproval automations, held for the owner on the history volume; /automations pending routes approve
    // or reject, and a countdown hold the daemon minted releases itself.
    readonly heldWakes: HeldWakesStore;
    // How far the scheduler has accounted for each schedule's clock; what a boot reads to fire the moments it slept through.
    readonly scheduleCoverage: ScheduleCoverageStore;
    // Which conversation each inbound thread owns; lets a message stream remember instead of starting fresh.
    readonly threadSessions: ThreadSessionsStore;
    // Who has written to each listener source, admitted or not; what the sender rules picker offers by name.
    readonly senders: SendersStore;
}

export interface AutomationsDeps {
    readonly workspaceRoot: string;
    // The history volume, where the queue of held wakes lives: off the workspace, so a turn cannot queue or release one.
    readonly historyRoot: string;
    // Where the queue says what it cannot do (a signing key it cannot read).
    readonly logger: Pick<Logger, "warn">;
    // Whether a conversation is archived, so a thread whose conversation was archived starts fresh.
    readonly archived: (conversationId: string) => boolean;
}

// Builds the automations half of the slice: its documents under the workspace root.
export const createAutomationsSlice = ({ workspaceRoot, historyRoot, logger, archived }: AutomationsDeps): AutomationsSlice => ({
    automations: fileAutomationsStore(join(workspaceRoot, automationsDocument.path), join(workspaceRoot, automationRunsDocument.path)),
    heldWakes: fileHeldWakesStore(historyRoot, (message, reason) => logger.warn({ reason }, message)),
    scheduleCoverage: fileScheduleCoverageStore(join(workspaceRoot, scheduleCoverageDocument.path)),
    threadSessions: fileThreadSessionsStore(join(workspaceRoot, threadSessionsDocument.path), archived),
    senders: fileSendersStore(join(workspaceRoot, sendersDocument.path)),
});
