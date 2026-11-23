import { sandboxRef } from "@intentic/extension-api";
import { z } from "zod";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { runnerTerminalsKey, storedJson, storeJson } from "../../app/storage/browserStorage";
import type { TranscriptTerminalHelp } from "@intentic/sandbox-contract/events/transcript";
import type { TerminalTab } from "../../features/terminal/useTerminal";
import { type RunnerViewSeams, runnerViewSeams, viewQuery } from "../runners/runnerViews";
import { isRunnerTab, parseRunnerTab, type RunnerTerminal, runnerTabName } from "./runnerTabNames";
import type { TerminalDoor, TerminalParams } from "./terminalDoor";

// THE TERMINAL OF A CONVERSATION THAT RUNS ON A RUNNER, AS A TAB OF THE TERMINAL PANEL. The session is a tmux session on
// the runner (its `terminal` frame, a job's `session`), reached through this sandbox at the path and one-shot ticket
// `runners.openView` answers, asked afresh for every dial. The tab's name carries all a dial needs (runnerTabNames.ts),
// so a door needs no held list. Which ones this browser has open is kept per sandbox, so a reload reattaches them. Closing the tab only
// forgets it: the session is the runner's, and its agent may still be using it.

/**
 * The tab a conversation's terminal session opens as: the runner's tab for a conversation that runs on one, the
 * session itself (this sandbox's own tmux) otherwise, and a name that already is a runner tab as it stands.
 */
export const terminalTabFor = (
    conversationId: string | undefined,
    session: string,
    runnerOfConversation: (id: string | undefined) => string | undefined,
): string => {
    if (isRunnerTab(session) || conversationId === undefined) {
        return session;
    }
    const runner = runnerOfConversation(conversationId);
    return runner === undefined ? session : runnerTabName({ runner, conversationId, session });
};

const StoredSchema = z.array(z.string());
const storageKey = (): string => runnerTerminalsKey(activeSandboxId.value ?? `local`);
const held = sandboxRef<string[]>(() => (storedJson(storageKey(), StoredSchema.catch([])) ?? []).filter((name) => parseRunnerTab(name) !== undefined));
const persist = (): void => {
    storeJson(storageKey(), held.value);
};

/** Holds a runner tab open in this browser, once; any other name is left alone. */
export const holdRunnerTerminal = (name: string): void => {
    if (parseRunnerTab(name) === undefined || held.value.includes(name)) {
        return;
    }
    held.value = [...held.value, name];
    persist();
};

/** Lets a runner tab go: closed in the panel, or ended on the runner. */
export const forgetRunnerTerminal = (name: string): void => {
    if (held.value.includes(name)) {
        held.value = held.value.filter((entry) => entry !== name);
        persist();
    }
};

/** The runner tabs as the panel lists them: labelled with where the session runs, running until the runner says not. */
export const runnerTerminalTabs = (): TerminalTab[] =>
    held.value.flatMap((name) => {
        const terminal = parseRunnerTab(name);
        return terminal === undefined ? [] : [{ name, label: `${terminal.runner} · ${terminal.session}`, kind: `runner` as const, running: true, activityAt: 0 }];
    });

/** Where a runner terminal's socket dials: a fresh view (and ticket) per dial, with the attach's grid and sight. */
export const runnerDoor = (terminal: RunnerTerminal, seams: RunnerViewSeams = runnerViewSeams): TerminalDoor => ({
    address: async (params: TerminalParams) => {
        const base = seams.base();
        if (base === undefined) {
            return undefined;
        }
        const view = await seams.openView({ conversationId: terminal.conversationId, kind: `terminal`, session: terminal.session });
        return { base, path: view.path, query: viewQuery(view, { cols: params.cols, rows: params.rows, away: params.away, deflate: params.deflate }) };
    },
});

/** The terminal panel's door for a runner tab, or undefined for any other. */
export const runnerDoorFor = (tab: Pick<TerminalTab, `name`>): TerminalDoor | undefined => {
    const terminal = parseRunnerTab(tab.name);
    return terminal === undefined ? undefined : runnerDoor(terminal);
};

/** What the panel's Done banner needs of an ask: the id an answer names, and the agent's words. */
export type TerminalAsk = Pick<TranscriptTerminalHelp, `requestId` | `message`>;

/** The newest hand-over still waiting at this session among a conversation's rows, or undefined. */
export const pendingTerminalHelp = (
    rows: readonly { readonly terminalHelp?: TranscriptTerminalHelp | undefined }[],
    session: string,
): TerminalAsk | undefined => {
    const ask = rows.findLast((row) => row.terminalHelp?.status === `pending` && row.terminalHelp.session === session)?.terminalHelp;
    return ask === undefined ? undefined : { requestId: ask.requestId, message: ask.message };
};

/**
 * A runner tab's open ask, for the terminal panel's Done banner: a runner's session is in no list of this sandbox's, so
 * the ask is read off its conversation's pending `terminal_help` card, while that conversation is open in this window.
 * The answer goes the usual way (agent.reply), which this sandbox carries to the runner.
 */
export const runnerTerminalHelp = (
    name: string | undefined,
    rowsOf: (conversationId: string) => readonly { readonly terminalHelp?: TranscriptTerminalHelp | undefined }[] | undefined,
): TerminalAsk | undefined => {
    const terminal = name === undefined ? undefined : parseRunnerTab(name);
    const rows = terminal === undefined ? undefined : rowsOf(terminal.conversationId);
    return terminal === undefined || rows === undefined ? undefined : pendingTerminalHelp(rows, terminal.session);
};
