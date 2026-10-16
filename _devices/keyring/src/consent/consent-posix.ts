import type { Notice, PassphrasePrompt, PromptAnswer } from "./consent.js";
import type { RunAnswer, Runner } from "../run.js";

// The passphrase dialog on Linux and macOS. Linux: zenity, then kdialog where there is a display, then
// systemd-ask-password; macOS: osascript's `display dialog … with hidden answer`. The title and message are not secret
// and ride the command line where the program takes them nowhere else; what the person types comes back on standard
// output, a pipe to this process alone. zenity's `--entry --hide-text` rather than `--password`, which has no place for
// the message that says what is asked.

const PROMPT_SECONDS = 120;
const PROMPT_TIMEOUT_MS = (PROMPT_SECONDS + 5) * 1000;

// What the person typed, without the one line break the dialog ends it with.
const typed = (answer: RunAnswer): string => answer.stdout.replace(/\r?\n$/u, "");

// zenity reads its text as Pango markup, where `&` and `<` are syntax.
const markupText = (text: string): string => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

interface Dialog {
    readonly command: string;
    readonly args: (notice: Notice) => readonly string[];
    // Exit codes that mean the person closed it or let it time out.
    readonly cancelled: readonly number[];
}

const DIALOGS: readonly Dialog[] = [
    {
        command: "zenity",
        args: (notice) => ["--entry", "--hide-text", `--title=${notice.title}`, `--text=${markupText(notice.message)}`, `--timeout=${String(PROMPT_SECONDS)}`],
        cancelled: [1, 5],
    },
    { command: "kdialog", args: (notice) => ["--title", notice.title, "--password", notice.message], cancelled: [1] },
];

const ASK_PASSWORD: Dialog = {
    command: "systemd-ask-password",
    args: (notice) => [`--timeout=${String(PROMPT_SECONDS)}`, `${notice.title} ${notice.message}`],
    cancelled: [1],
};

export const linuxPassphrasePrompt =
    (runner: Runner, env: NodeJS.ProcessEnv = process.env): PassphrasePrompt =>
    async (notice) => {
        const graphical = (env["DISPLAY"] ?? "") !== "" || (env["WAYLAND_DISPLAY"] ?? "") !== "";
        const dialogs = graphical ? [...DIALOGS, ASK_PASSWORD] : [ASK_PASSWORD];
        const tried: string[] = [];
        for (const dialog of dialogs) {
            const answer = await runner({ command: dialog.command, args: dialog.args(notice), timeoutMs: PROMPT_TIMEOUT_MS });
            if (answer.missing) {
                tried.push(`no ${dialog.command}`);
                continue;
            }
            if (answer.exitCode === 0 && !answer.timedOut) {
                return { kind: "answered", passphrase: typed(answer) };
            }
            if (answer.exitCode !== null && dialog.cancelled.includes(answer.exitCode)) {
                return { kind: "cancelled" };
            }
            // It started and failed (no display it can open, no password agent): the next one may do better.
            tried.push(`${dialog.command} could not ask (exit ${String(answer.exitCode ?? "none")})`);
        }
        return {
            kind: "unavailable",
            reason: `${tried.join(", ")}${graphical ? "" : ", and no display to show a dialog on"}: install zenity or kdialog, or unlock from a desktop session`,
        };
    };

// AppleScript's string literal: a backslash and a double quote are its only syntax.
const appleScriptText = (text: string): string => `"${text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;

export const macDialogScript = (notice: Notice): string =>
    [
        `set answer to display dialog ${appleScriptText(`${notice.message}\n\nThe keyring's passphrase:`)} with title ${appleScriptText(notice.title)} default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" giving up after ${String(PROMPT_SECONDS)}`,
        `if gave up of answer then error number -128`,
        `return text returned of answer`,
    ].join("\n");

export const macPassphrasePrompt =
    (runner: Runner): PassphrasePrompt =>
    async (notice): Promise<PromptAnswer> => {
        // The script on standard input, so nothing of the prompt rides the command line either.
        const answer = await runner({ command: "osascript", args: ["-"], input: macDialogScript(notice), timeoutMs: PROMPT_TIMEOUT_MS });
        if (answer.missing) {
            return { kind: "unavailable", reason: "osascript was not found" };
        }
        if (answer.exitCode === 0 && !answer.timedOut) {
            return { kind: "answered", passphrase: typed(answer) };
        }
        return /-128/u.test(answer.stderr) ? { kind: "cancelled" } : { kind: "unavailable", reason: "the dialog could not be shown (no desktop session?)" };
    };
