import type { OpenCodeClient } from "@opencode/client";
import { turnRunOf } from "../../../conversations/actor/conversation-holdings.js";
import { type BackgroundJobSeed, jobCommandLine } from "../../../agent/tools/jobs/background-jobs.js";
import type { ShellRoute } from "./opencode-shell.js";
import { BACKGROUND_WAIT_MS } from "../opencode-turn.js";

/* WHAT AN OPENCODE TURN LEAVES RUNNING (2026-11-17, the shinobi-society audit). A turn whose own work has ended waits
   BACKGROUND_WAIT_MS at most on the shells it left in the background, and its ending used to remove every one still
   running, silently: an agent whose build died at ten minutes could only guess why, and OpenCode keeps its own session
   history, so nothing the daemon wrote beside it reached the model. Now a shell whose command runs in the conversation's
   pane is asked back as a sandbox job first (opencode-turn.ts backgroundWaitOver), its note opening with HANDED_BACK;
   one that is still stopped is said to the person as a notice on the turn, and to the model as a message in its own
   session that its next turn reads, naming the command, why, and what to do instead. */

const minutes = `${String(BACKGROUND_WAIT_MS / 60_000)} minutes`;

// What a pane command asked back is told, before the note naming its job.
export const HANDED_BACK = `Your turn waited ${minutes} on this background command after its own work ended, the longest it waits on one, so the sandbox took the command over instead of stopping it.`;

/** Asks the pane commands of a turn's shells back as jobs; none where its shell is not routed through a pane. */
export const handBack = (route: ShellRoute | undefined): readonly string[] => route?.release(HANDED_BACK) ?? [];

// Why the turn let go of its shells: its wait on them ran out, or it ended first (stopped, failed, timed out).
export type LeftBecause = "waited" | "cut";

const quoted = (commands: readonly string[]): string => commands.map((command) => `\`${jobCommandLine(command)}\``).join(", ");

/**
 * What the model reads on its next turn of the shells its last one left running and the sandbox stopped. `adopts` says
 * whether a long foreground command would have been filed as a job (a pane and a job seed), which decides the advice.
 */
export const stoppedNote = (commands: readonly string[], because: LeftBecause, adopts: boolean): string => {
    const one = commands.length === 1;
    const them = one ? "it" : "them";
    const why =
        because === "waited"
            ? `The turn had waited ${minutes} on its background shells after its own work ended, the longest an OpenCode turn waits on them, and a shell does not outlive its turn.`
            : "The turn ended first (it was stopped, failed or timed out), and a shell does not outlive its turn.";
    const instead = adopts
        ? "For long work, run the command in the foreground instead: one still running after about two minutes is handed to the sandbox as a background job, which outlives the turn, wakes this conversation when it exits, and can be waited on with the `wait` tool."
        : "For long work, run the command in the foreground with a `timeout` that covers it, or split it into steps that each finish sooner.";
    return `The sandbox stopped ${one ? "a background shell" : `${String(commands.length)} background shells`} your previous turn left running: ${quoted(commands)}. ${why} Nothing of ${them} is running now. ${instead}`;
};

/** The notice the person sees on the turn. */
export const stoppedNotice = (commands: readonly string[], because: LeftBecause): string =>
    `Stopped ${commands.length === 1 ? "the background shell" : `${String(commands.length)} background shells`} the turn left running: ${quoted(commands)}${
        because === "waited" ? `, the turn having waited ${minutes} on its background shells once its own work ended` : ", since the turn ended first"
    }. The agent is told on its next turn.`;

// One shell's command, as OpenCode ran it; undefined for one already ended, which has nothing left to stop.
const commandOf = async (c: OpenCodeClient, id: string, cwd: string): Promise<string | undefined> => {
    try {
        const { data } = await c.shell.get({ id, location: { directory: cwd } });
        return data.status === "running" ? data.command : undefined;
    } catch {
        // allow(silent-catch): a shell that cannot be read is still stopped below, said by its id
        return `(background shell ${id})`;
    }
};

// What a turn's leftovers are read from: the turn, its family (sessions, shells, judges), and how it ended.
interface LeftTurn {
    readonly cwd: string;
    readonly sealed?: true;
    readonly say?: (text: string) => void;
}
interface LeftFamily {
    readonly members: () => ReadonlySet<string>;
    readonly shells: () => ReadonlySet<string>;
    readonly release: () => void;
}
interface LeftEnding {
    // The turn's wait on its background shells ran out (opencode-turn.ts backgroundWaitOver).
    readonly waited: boolean;
    readonly route: ShellRoute | undefined;
}

/**
 * What a turn leaves running, taken back: its shells and its judges. A shell outliving its turn would wake the session
 * with nobody judging what it does next, so each still running is stopped, and then said: a notice for the person, and
 * for the model a message in its own session (the family's first), which OpenCode hands it with its next prompt
 * (`resume: false` wakes nothing now). A sealed request's session is deleted after, so it is told nothing.
 */
export const leaveTurn = async (c: OpenCodeClient, turn: LeftTurn, family: LeftFamily | undefined, ending: LeftEnding): Promise<void> => {
    const stopped = await Promise.all(
        [...(family?.shells() ?? [])].map(async (id) => {
            const command = await commandOf(c, id, turn.cwd);
            // allow(silent-catch): a shell that already ended has nothing left to stop
            await c.shell.remove({ id, location: { directory: turn.cwd } }).catch(() => {});
            return command;
        }),
    );
    family?.release();
    const commands = stopped.filter((command): command is string => command !== undefined);
    const session = family?.members().values().next().value;
    if (commands.length === 0) {
        return;
    }
    const because: LeftBecause = ending.waited ? "waited" : "cut";
    turn.say?.(stoppedNotice(commands, because));
    if (session !== undefined && turn.sealed !== true) {
        const text = stoppedNote(commands, because, ending.route?.adopts === true);
        // allow(silent-catch): a session that cannot take the note still has the person's notice
        await c.session.synthetic({ sessionID: session, text, resume: false }).catch(() => {});
    }
};

/** How a turn writes a notice on its own record: where its background jobs' rows go. */
export const noticeVia =
    (jobs: BackgroundJobSeed | undefined): ((text: string) => void) | undefined =>
        jobs === undefined ? undefined : (text) => turnRunOf(jobs.conversations, jobs.conversationId)?.note({ role: "notice", text });
