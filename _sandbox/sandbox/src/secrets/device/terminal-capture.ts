import { appendFile } from "node:fs/promises";
import { forkedExec } from "@intentic/base/git";
import { WEB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import type { Logger } from "pino";
import { captureTarget, sendSandboxCapture } from "./keyring-capture.js";
import type { KeyringLink } from "./keyring-link.js";
import { opt } from "../../opt.js";
import { clampCommand, commandTitle, remembersPrompt } from "./prompt-capture.js";

// REMEMBERING A PASSWORD TYPED INTO A PERSON'S TERMINAL (source `terminal`, the keyring's `remember.sandbox` switch).
// netd serves the editor's terminals and never hands this daemon their bytes; it watches only the editor's own
// sessions (`web-…`, never an agent's), and when the person answers a password-ish question with the pane's echo off it
// tells this daemon the session, the question and the line typed, once (`ToNode::HiddenLine`, its term/hidden.rs). Here
// the question is judged again (a one-time code is never kept), the owner's computer that remembers from sandboxes is
// found, the value is sealed to its inbox key and sent (keyring-capture.ts) and dropped, and the pane hears one dim line
// saying where it went.

export interface PaneFacts {
    // The command line of the pane's foreground process, `npm login`, when one can be read.
    readonly command: (session: string) => Promise<string | undefined>;
    // Writes one line onto the pane, as output, for whoever is looking at it.
    readonly notice: (session: string, text: string) => Promise<void>;
}

export interface TerminalCaptureDeps {
    readonly link: Pick<KeyringLink, "computers" | "passwords" | "sandboxUrl">;
    readonly pane?: PaneFacts;
    readonly logger: Pick<Logger, "warn">;
}

const paneTty = async (session: string): Promise<string | undefined> => {
    const { stdout } = await forkedExec("tmux", ["display-message", "-p", "-t", `=${session}:`, "#{pane_tty}"]);
    const tty = stdout.trim();
    return tty.startsWith("/dev/") ? tty : undefined;
};

// `ps` marks the terminal's foreground process group with `+`; the last of them is the program asking.
export const foregroundCommand = (psOut: string): string | undefined =>
    psOut
        .split("\n")
        .map((line) => line.trim().match(/^(\S+)\s+(.+)$/u))
        .filter((match): match is RegExpMatchArray => match?.[1]?.includes("+") === true)
        .map((match) => match[2] ?? "")
        .at(-1);

const tmuxPaneFacts: PaneFacts = {
    command: async (session) => {
        const tty = await paneTty(session);
        return tty === undefined ? undefined : foregroundCommand((await forkedExec("ps", ["-t", tty.replace(/^\/dev\//u, ""), "-o", "stat=,args="])).stdout);
    },
    notice: async (session, text) => {
        const tty = await paneTty(session);
        if (tty !== undefined) {
            await appendFile(tty, `\r\n\u001b[2m${text}\u001b[0m\r\n`);
        }
    },
};

export const createTerminalCapture = ({ link, pane = tmuxPaneFacts, logger }: TerminalCaptureDeps) => {
    const quiet = (what: string) => (error: Error) => {
        // Never the keystrokes: only that a step of the capture did not happen.
        logger.warn({ err: error }, `terminal capture: ${what}`);
    };
    const deliver = async (session: string, prompt: string, value: string): Promise<void> => {
        if (captureTarget(await link.computers()) === undefined) {
            return;
        }
        // allow(silent-catch): a command that cannot be read only leaves the entry titled by its prompt
        const command = await pane.command(session).catch(() => undefined);
        const title = commandTitle(command);
        const sent = await sendSandboxCapture(link, {
            origin: { kind: "prompt", text: prompt, ...opt("command", clampCommand(command)), sandbox: await link.sandboxUrl() },
            value,
            ...opt("title", title),
        });
        if (sent.ok && (sent.outcome === "saved" || sent.outcome === "updated")) {
            await pane.notice(session, `Saved '${sent.title ?? title ?? prompt}' to Passwords on ${sent.machine}`);
        }
    };
    return {
        /**
         * A line netd saw typed with echo off after a password-ish question in one of the editor's sessions: kept by the
         * owner's computer that remembers from sandboxes, unless the question was not a password's.
         */
        entered: (session: string, prompt: string, value: string): void => {
            if (!session.startsWith(WEB_SESSION_PREFIX) || !remembersPrompt(prompt)) {
                return;
            }
            void deliver(session, prompt, value).catch(quiet("the password could not be sent to be remembered"));
        },
    };
};
