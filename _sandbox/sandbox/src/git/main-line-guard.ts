import { type CommandContext, matchCommand } from "@intentic/sandbox-contract/policy/command-classes";
import type { GuardOutcome } from "../guard/command-guard.js";

// The shared checkout stays on its main line (git/main-line-lock.ts), so a turn working in it is refused a branch switch
// outright, ahead of the safety tiers and with no card: it is no one's call to make for everyone else in the sandbox.
// A conversation's own copy is its own to move (`ownCheckout`), as the class itself says. What only a shell would not
// run (a heredoc, a quoted argument) is not a switch.

export const MAIN_LINE_REFUSAL =
    "Refused: the shared workspace stays on its main line, since every agent and every person here starts from it and lands into it. " +
    "Do not switch it, and do not look for another way to: to work on another branch, ask the person to start an agent from it. " +
    "To restore files instead, use `git restore <path>` or `git checkout -- <path>`.";

/** A refusal for a command that would move the shared checkout's HEAD, else undefined. */
export const mainLineOutcome = (context: CommandContext, program: string): GuardOutcome | undefined => {
    if (context.ownCheckout === true) {
        return undefined;
    }
    const switching = matchCommand(program, context).some((match) => match.commandClass === "git.branch-switch" && match.live);
    return switching ? { allow: false, reason: MAIN_LINE_REFUSAL } : undefined;
};
