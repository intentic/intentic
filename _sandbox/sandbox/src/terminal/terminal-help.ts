import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../runtimes/claude/claude-sdk.js";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { z } from "zod";
import { createRequest, resolveRequest } from "../agent/tools/agent-requests.js";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { publishRuntimeChange } from "../system/runtime-watch.js";
import { captureScrollback } from "./terminal-session.js";

// Hands the terminal back to the person, the browser handover's twin: every Bash command runs in a tmux window the
// owner can type into, so a prompt is one keystroke from being answered. Parks only on a command already waiting; the
// hand-back carries the pane's own recent output, bounded to a screenful.

const execFileAsync = promisify(execFile);

// How much of the pane rides back: enough for an install's tail, not so much it turns into a log dump.
const HANDBACK_LINES = 200;

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

// One open ask, keyed by session rather than turn, since the terminals list and the panel's banner both render by
// session; a turn parks on at most one at a time.
interface TerminalHelp {
    readonly requestId: string;
    readonly message: string;
    readonly requestedAt: number;
}

const asks = new Map<string, TerminalHelp>();

// The newest window whose pane is alive (a dead one is a finished command tmux-run kept for its output), by
// window_activity since tmux renumbers. Name last, space-separated: a tab sanitizes to an underscore off UTF-8.
export const liveWindow = async (session: string): Promise<{ id: string; name: string } | undefined> => {
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync("tmux", [
            "list-panes",
            "-s",
            "-t",
            `=${session}`,
            "-F",
            "#{pane_dead} #{window_id} #{window_activity} #{window_name}",
        ]));
    } catch {
        // No such session, or no tmux server at all, both are "nothing to hand over".
        return undefined;
    }
    const live = stdout
        .split("\n")
        .flatMap((line) => {
            const [dead, id, activity, ...name] = line.split(" ");
            if (dead !== "0" || id === undefined || id === "") {
                return [];
            }
            const at = Number(activity);
            return [{ id, name: name.join(" ") || "run", at: Number.isFinite(at) ? at : 0 }];
        })
        .toSorted((a, b) => a.at - b.at);
    const newest = live.at(-1);
    return newest === undefined ? undefined : { id: newest.id, name: newest.name };
};

// An attaching client opens on the session's current window, so this puts the owner on the right one instead of
// whatever ran last. Best-effort: a vanished window is a race the banner survives.
export const selectWindow = async (id: string): Promise<void> => {
    await execFileAsync("tmux", ["select-window", "-t", id]).catch(() => undefined);
};

// Raise the ask against a session, the state half the terminals list renders from.
export const raiseTerminalHelp = (session: string, help: TerminalHelp): void => {
    asks.set(session, help);
    publishRuntimeChange("terminals");
};

// Clears the banner however the waiter settled (answered, dismissed, aborted). Keyed by requestId, not session, so a
// stale settle can't clear a newer ask.
export const clearTerminalHelp = (requestId: string): void => {
    for (const [session, help] of asks) {
        if (help.requestId === requestId) {
            asks.delete(session);
            publishRuntimeChange("terminals");
        }
    }
};

// What the terminals list hangs on the session's row.
export const terminalHelpFor = (session: string): TerminalHelp | undefined => asks.get(session);

// Called when the session dies under a parked ask (killed or reaped); settles it as not-helped, since nothing else
// would ever release a wait on a person. Idempotent: a racing turn-abort settle finds the request already gone.
export const settleTerminalHelpFor = (session: string): void => {
    const help = asks.get(session);
    if (help === undefined) {
        return;
    }
    resolveRequest({
        kind: "terminal_help",
        requestId: help.requestId,
        helped: false,
        note: "the terminal was closed before anyone could help",
    });
    asks.delete(session);
    publishRuntimeChange("terminals");
};

export interface TerminalHelpDeps {
    // Read at call time, not captured: a fresh session only learns its id from the init frame.
    readonly shell: { readonly sessionId: string | undefined };
    readonly conversationId?: string | undefined;
    readonly signal: AbortSignal;
    readonly push: (event: AgentEvent) => void;
}

export const terminalHelpServer = (deps: TerminalHelpDeps): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "terminal",
        // Deferred behind tool search: a model has to be told about the handover at the moment it matters via the
        // system prompt (TERMINAL_GUIDANCE), not rely on discovering this tool by searching.
        tools: [
            sdk().tool(
                "request_help",
                "Ask the owner to type into your terminal and clear something only a person can, a one-time password, a security-key touch, a confirmation you cannot answer. Use it when a command you started is SITTING AT A PROMPT (Bash handed the turn back saying it is still running): the command keeps waiting, the owner is shown your message over that very terminal, types, and hands back. This call waits for them and returns what the terminal says afterwards. Say precisely what you need typed.",
                {
                    message: z.string().min(1).describe("What you need the owner to do at the terminal, in one or two sentences"),
                },
                async ({ message }) => {
                    const sessionId = deps.shell.sessionId;
                    const session = sessionId === undefined ? undefined : agentSessionName(sessionId);
                    if (session === undefined) {
                        return fail("this turn has no terminal of its own: run the command with Bash first");
                    }
                    // Checked before parking: a session with no live window has no prompt for the owner to answer.
                    const window = await liveWindow(session);
                    if (window === undefined) {
                        return fail(
                            `nothing is waiting in your terminal: run the command that needs a person first, and ask once Bash tells you it is still running`,
                        );
                    }
                    await selectWindow(window.id);
                    const { id, wait } = createRequest(
                        "terminal_help",
                        { kind: "terminal_help", requestId: "", helped: false, note: "the turn ended before anyone could help" },
                        deps.conversationId,
                    );
                    raiseTerminalHelp(session, { requestId: id, message, requestedAt: Date.now() });
                    deps.push({ kind: "terminal_help", requestId: id, session, message });
                    const { reply, resolved } = await wait(deps.signal);
                    clearTerminalHelp(id);
                    deps.push(resolved);
                    const note = reply.note === undefined || reply.note === "" ? "" : ` They say: ${reply.note}`;
                    if (!reply.helped) {
                        return ok(`The owner could not help right now: note where you are stuck and continue with what you can.${note}`);
                    }
                    // Reads back whatever the owner ended on; wrapped, since these are a command's bytes and could be
                    // anyone's, matching how Bash wraps output that touched the open internet. Only that field, not the
                    // surrounding sentence.
                    const screen = await captureScrollback(session, HANDBACK_LINES);
                    const tail =
                        screen === undefined || screen.text === ""
                            ? ""
                            : `\n\nThe terminal now reads:\n${wrapOutsideContent(screen.text, { source: "terminal" })}`;
                    return ok(`The owner stepped in and is done.${note}${tail}`);
                },
            ),
        ],
    });
