import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../claude/claude-sdk.js";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { z } from "zod";
import { createRequest, resolveRequest } from "../agent/agent-requests.js";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { publishRuntimeChange } from "../system/runtime-watch.js";
import { captureScrollback } from "./terminal-session.js";

/* HANDING THE TERMINAL BACK TO THE PERSON, the browser handover's twin, one door along.
 *
 * The agent's browser already has this: it hits a captcha, calls `request_help`, and parks while the owner
 * takes the wheel on /browsers (browser/accounts-tools.ts raises it, browser/browser-sessions.ts holds it).
 * The terminal had the harder half of that already built and no way to ask for it, every Bash command runs in
 * a tmux window the owner can attach to AND TYPE INTO (agent/agent-terminals.ts, bin/tmux-run), so a command
 * sitting at an OTP prompt is one keystroke from being answered by the one person who can answer it. What was
 * missing was the agent being able to say so. Without it the turn's only move was to write the command out in
 * prose and hope the owner ran it in their own shell, which is what happened on the publish that prompted
 * this, and it hands the owner a second, colder copy of a job already half-done in a pane nobody looked at.
 *
 * WHAT THIS PARKS ON is a command that is ALREADY WAITING. The agent does not start anything here: it runs the
 * command through Bash as always, tmux-run's soft timeout hands the turn back with "still running in window X"
 * while the pane stays alive at its prompt, and THEN the agent asks. So the tool's precondition is a live pane,
 * and its refusal ("nothing is waiting") is the honest answer for a session whose every window has exited.
 *
 * WHAT COMES BACK is the pane's own recent output, not just the owner's note. The moment the agent cannot see
 * is exactly the moment it handed over, an answered prompt, whatever the command printed after it, and
 * asking the owner to narrate that (or re-running something to find out) is the cost this avoids. Bounded to a
 * screenful-and-then-some, because it lands in the model's context and in the saved conversation.
 */

const execFileAsync = promisify(execFile);

// How much of the pane rides back with the hand-back. Enough for the tail of an install or a publish, small
// enough that a parked turn's answer stays an answer rather than a log dump.
const HANDBACK_LINES = 200;

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

// One open ask, keyed by the tmux session it is parked on. A turn has ONE agent session and parks on one thing
// at a time, so this is at most one entry per conversation in flight, but it is keyed by session rather than
// held on a turn because the terminals list and the panel's banner are what render it, and both speak sessions.
interface TerminalHelp {
    readonly requestId: string;
    readonly message: string;
    readonly requestedAt: number;
}

const asks = new Map<string, TerminalHelp>();

/* Which window the owner should land on: the NEWEST one whose pane is still alive.
 *
 * A finished command's window lingers as a DEAD pane (tmux-run sets remain-on-exit so its output stays
 * readable), so "alive" is exactly "has not returned", a command waiting at a prompt, or a server the agent
 * left running. Newest wins because the prompt the agent just parked on is by definition the last thing it
 * started. Undefined means every window has exited: there is nothing to hand over, which the tool refuses on
 * rather than parking the turn on a banner over a dead pane.
 *
 * `window_activity` rather than list order: tmux renumbers, and the sort has to mean "most recent".
 *
 * THE FORMAT IS SPACE-SEPARATED AND THE NAME COMES LAST, because a tab does not survive the trip out of tmux.
 * What a command prints back to a client is sanitized unless that client's locale says UTF-8 (LC_ALL, LC_CTYPE
 * or LANG), and sanitizing turns every control character, a tab included, into an underscore. The sandbox
 * image sets LANG (its Dockerfile), so a tab-separated format reads fine wherever the daemon actually runs and
 * silently stops parsing anywhere else: `#{window_name}\t#{pane_dead}` comes back `publish_0`, every field
 * lands in the first one, and this returns "nothing is waiting" over a session with a prompt in it. That is
 * what CI saw. A space costs nothing here, the only free-form field is the window name, so it goes last and
 * takes the whole rest of the line, spaces and all.
 *
 * Exported for the integration test alone (terminal-help.integration.test.ts): "which window is the owner
 * sent to" is the one piece of this feature that is entirely tmux's answer rather than this module's, and it
 * is worth pinning against a real server, a stub can only confirm the flags it was written to expect.
 */
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

// Put the owner in front of the right pane. An attaching tmux client opens on the session's CURRENT window, so
// without this the owner lands on whatever the agent ran last rather than on the one that stopped for them.
// Best-effort: a window that vanished between the two calls is a race the banner survives, the owner is still
// looking at the right session, and the tool's own refusal path already covers "nothing is waiting at all".
export const selectWindow = async (id: string): Promise<void> => {
    await execFileAsync("tmux", ["select-window", "-t", id]).catch(() => undefined);
};

// Raise the ask against a session, the state half the terminals list renders from.
export const raiseTerminalHelp = (session: string, help: TerminalHelp): void => {
    asks.set(session, help);
    publishRuntimeChange("terminals");
};

// The waiter settled (answered, dismissed, or the turn aborted under it), the banner comes down however it
// ended. By requestId rather than by session, so a stale settle can never clear a NEWER ask on the same
// session, exactly as the browser's does.
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

/* THE SESSION DIED UNDER A PARKED ASK, the owner ×-killed the agent's terminal, or the reaper took it.
 *
 * The parked tool call is waiting on a PERSON, not on tmux, so nothing else would ever release it: the turn
 * would sit parked on a banner this very kill just took down. Settled as "not helped", which is the honest
 * account of a terminal that went away before anyone typed in it. Idempotent, a turn-abort settle racing in
 * finds the request already gone (agent-requests.ts resolveRequest returns false and this clears nothing).
 */
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
    // The SDK session id, read at CALL time rather than captured: a turn that starts a fresh session learns its
    // id from the init frame, and the handle agent.ts threads through the ask tool is the same one (agent.ts).
    readonly shell: { readonly sessionId: string | undefined };
    readonly conversationId?: string | undefined;
    readonly signal: AbortSignal;
    readonly push: (event: AgentEvent) => void;
}

export const terminalHelpServer = (deps: TerminalHelpDeps): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "terminal",
        /* IN THE PROMPT, not behind tool search, the `ui` ask tool's reasoning, and this feature is the
         * clearest case of it there is. A model that has to go LOOKING for this tool does not know the
         * handover exists at the one moment it matters, and what it does instead is exactly what prompted this
         * work: it writes the command out in prose and asks the owner to run it in their own shell, next to a
         * pane already sitting at the prompt. The tool is worth its place in every turn's context precisely
         * because the alternative is not "no handover" but "a worse handover, in words". */
        alwaysLoad: true,
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
                    // The precondition, checked before anything parks: a session whose every window has exited
                    // has no prompt for the owner to answer, and a banner over it could only mislead.
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
                    /* What the pane says NOW is the whole point of the hand-back: the owner answering the
                     * prompt is the one thing the agent could not watch. Whatever window they ended on, since
                     * that is where they were working, and undefined (session gone) is not an error here, only
                     * a hand-back with nothing left to read.
                     *
                     * WRAPPED, because these are a COMMAND'S bytes and a command's bytes can be anyone's. The
                     * Bash tool already wraps its own result when the command reached the open internet
                     * (guard/outside-results.ts), and this reads the same output back off the pane a moment
                     * later, so leaving it plain would be a way to launder exactly what that seam wraps:
                     * fetch, let it stall, hand over, read the answer back clean. Only this field: the
                     * daemon's sentence and the owner's note are the platform's and the owner's own words. */
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
