import type { CreateTerminalRequest, TerminalExitStatus, TerminalOutputResponse } from "@agentclientprotocol/sdk";
import type { TerminalRunner } from "../terminal/terminal-run.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

/* ACP terminal/* over the tmux substrate: `create` starts the command in a visible window of the ACP
 * conversation's `agent-<id>` session (the exact panel UX Claude's Bash gets) and returns a handle
 * immediately; the runner's promise settles the handle with the captured output + exit code. Mid-run
 * `terminal/output` honestly returns empty (the wrapper tees output to the pane and ships it once at
 * completion — the LIVE view is the terminal panel, which is the point); `wait_for_exit` is the agent's
 * primary pattern and works exactly. `kill` aborts the runner (SIGTERM → the wrapper kills the pane and
 * returns output-so-far); `release` of a still-running command kills it too — an untracked runaway pane
 * would outlive the turn otherwise. Pane scrollback + pane logs persist after release, per ACP's "clients
 * may keep displaying output". */

interface Handle {
    output: string;
    exit: TerminalExitStatus | undefined;
    killed: boolean;
    readonly limit: number | undefined;
    readonly controller: AbortController;
    readonly done: Promise<void>;
}

export interface AcpTerminals {
    readonly create: (session: string, cwd: string, request: CreateTerminalRequest) => string;
    readonly output: (terminalId: string) => TerminalOutputResponse | undefined;
    readonly waitForExit: (terminalId: string) => Promise<TerminalExitStatus> | undefined;
    readonly kill: (terminalId: string) => boolean;
    readonly release: (terminalId: string) => boolean;
    // Abort every live handle — the connection's teardown hygiene (a dead agent must not leave runaways).
    readonly disposeAll: () => void;
}

export const createAcpTerminals = (runner: TerminalRunner): AcpTerminals => {
    const handles = new Map<string, Handle>();
    let next = 0;

    return {
        create: (session, cwd, request) => {
            const id = `acpterm-${(next += 1)}`;
            const controller = new AbortController();
            const command = [request.command, ...(request.args ?? [])].map(shellQuote).join(" ");
            const env = Object.fromEntries((request.env ?? []).map((entry) => [entry.name, entry.value]));
            const partial: Omit<Handle, "done"> = {
                output: "",
                exit: undefined,
                killed: false,
                limit: request.outputByteLimit ?? undefined,
                controller,
            };
            const done = runner
                .tryRun(session, command, {
                    cwd: request.cwd ?? cwd,
                    window: "acp",
                    ...(Object.keys(env).length > 0 ? { env } : {}),
                    signal: controller.signal,
                })
                .then(
                    ({ code, output }) => {
                        handle.output = output;
                        handle.exit = handle.killed ? { exitCode: code, signal: "SIGTERM" } : { exitCode: code };
                    },
                    () => {
                        // An aborted runner throws (the kill path); anything else is a spawn failure.
                        handle.exit = handle.killed ? { signal: "SIGTERM" } : { exitCode: 1 };
                    },
                );
            const handle: Handle = { ...partial, done };
            handles.set(id, handle);
            return id;
        },
        output: (terminalId) => {
            const handle = handles.get(terminalId);
            if (handle === undefined) {
                return undefined;
            }
            const capped = handle.limit !== undefined && handle.output.length > handle.limit;
            return {
                output: capped ? handle.output.slice(-(handle.limit as number)) : handle.output,
                truncated: capped,
                ...(handle.exit !== undefined ? { exitStatus: handle.exit } : {}),
            };
        },
        waitForExit: (terminalId) => {
            const handle = handles.get(terminalId);
            if (handle === undefined) {
                return undefined;
            }
            return handle.done.then(() => handle.exit ?? { exitCode: 1 });
        },
        kill: (terminalId) => {
            const handle = handles.get(terminalId);
            if (handle === undefined) {
                return false;
            }
            if (handle.exit === undefined) {
                handle.killed = true;
                handle.controller.abort();
            }
            return true;
        },
        release: (terminalId) => {
            const handle = handles.get(terminalId);
            if (handle === undefined) {
                return false;
            }
            if (handle.exit === undefined) {
                handle.killed = true;
                handle.controller.abort();
            }
            handles.delete(terminalId);
            return true;
        },
        disposeAll: () => {
            for (const handle of handles.values()) {
                if (handle.exit === undefined) {
                    handle.killed = true;
                    handle.controller.abort();
                }
            }
            handles.clear();
        },
    };
};
