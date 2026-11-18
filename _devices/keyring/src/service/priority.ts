import { constants, getPriority, setPriority } from "node:os";

// PASSWORDS AT NORMAL PRIORITY (2026-11-18). Task Scheduler starts a task below normal unless told otherwise, and the
// service's task and the session helper's logon task both were. A person waits on everything the keyring answers, and a
// Windows computer busy with containers starved the two of them past every caller's deadline: the desktop app read
// Passwords as not answering, and starting it again found it running. The tasks are registered at normal priority now;
// this raises a process a task registered before that started, until its task is written again.

const NORMAL = constants.priority.PRIORITY_NORMAL;

/**
 * Raises process `pid` (this one, when absent) to normal priority where it runs below it, and never lowers one. Windows
 * only: raising a priority elsewhere needs a privilege the keyring does not have. Answers whether it was raised; a
 * process it may not touch, or one that is gone, is left as it is.
 */
export const atNormalPriority = (pid?: number, platform: NodeJS.Platform = process.platform): boolean => {
    if (platform !== "win32") {
        return false;
    }
    try {
        // Higher numbers are lower priorities: below normal reads as PRIORITY_BELOW_NORMAL (10).
        if (getPriority(pid ?? 0) <= NORMAL) {
            return false;
        }
        setPriority(pid ?? 0, NORMAL);
        return true;
    } catch {
        // allow(silent-catch): a process this user may not reach, or one that has exited, keeps whatever priority it had
        return false;
    }
};
