import type { ChoiceNotice, ChoicePrompt, Notice, PassphrasePrompt, ValueAnswer, ValueNotice, ValuePrompt } from "./consent.js";
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

// THE TYPE-ONCE BOX ON LINUX (consent.ts ValuePrompt): zenity's --forms, one dialog holding the user name when one is
// asked for, the value in a hidden field, and "Remember it" as a Yes/No choice (a checklist is clumsier for one box).
// zenity cannot prefill a form's field, so a user name already known is said in the text and kept as it is. Where only
// kdialog is there, the same in two dialogs: the hidden value, then a yes/no for remembering it. The fields come back on
// standard output, split by a separator no one types.

const FIELD_SEPARATOR = "\u001f";

const rememberWords = (remember: boolean): string => (remember ? "Yes|No" : "No|Yes");

export const zenityValueArgs = (notice: ValueNotice): readonly string[] => {
    const known = notice.username?.value;
    const text = known === undefined ? notice.message : `${notice.message}\n\nUser name: ${known}`;
    return [
        "--forms",
        `--title=${notice.title}`,
        `--text=${markupText(text)}`,
        `--separator=${FIELD_SEPARATOR}`,
        ...(notice.username !== undefined && known === undefined ? ["--add-entry=User name"] : []),
        "--add-password=Password",
        "--add-combo=Remember it in Passwords",
        `--combo-values=${rememberWords(notice.remember)}`,
        `--timeout=${String(PROMPT_SECONDS)}`,
    ];
};

/** zenity's answer to zenityValueArgs, read back. Pure. */
export const zenityValueAnswer = (stdout: string, notice: ValueNotice): ValueAnswer => {
    const fields = stdout.replace(/\r?\n$/u, "").split(FIELD_SEPARATOR);
    const asksName = notice.username !== undefined && notice.username.value === undefined;
    const [name, value, remember] = asksName ? fields : [notice.username?.value, ...fields];
    if (value === undefined || value === "") {
        return { kind: "cancelled" };
    }
    // An untouched choice comes back empty: the default the box was opened with stands.
    const kept = remember === "Yes" ? true : remember === "No" ? false : notice.remember;
    return name === undefined || name === "" ? { kind: "answered", value, remember: kept } : { kind: "answered", value, remember: kept, username: name };
};

const kdialogValue = async (runner: Runner, notice: ValueNotice): Promise<ValueAnswer | undefined> => {
    const asked = await runner({ command: "kdialog", args: ["--title", notice.title, "--password", notice.message], timeoutMs: PROMPT_TIMEOUT_MS });
    if (asked.missing) {
        return undefined;
    }
    if (asked.exitCode !== 0 || asked.timedOut || typed(asked) === "") {
        return { kind: "cancelled" };
    }
    const keep = await runner({ command: "kdialog", args: ["--title", notice.title, "--yesno", "Remember it in Passwords?"], timeoutMs: PROMPT_TIMEOUT_MS });
    const remember = keep.exitCode === 0 ? true : keep.exitCode === 1 ? false : notice.remember;
    const username = notice.username?.value;
    return username === undefined ? { kind: "answered", value: typed(asked), remember } : { kind: "answered", value: typed(asked), remember, username };
};

export const linuxValuePrompt =
    (runner: Runner, env: NodeJS.ProcessEnv = process.env): ValuePrompt =>
    async (notice) => {
        if ((env["DISPLAY"] ?? "") === "" && (env["WAYLAND_DISPLAY"] ?? "") === "") {
            return { kind: "unavailable", reason: "there is no display to show Passwords' box on" };
        }
        const answer = await runner({ command: "zenity", args: zenityValueArgs(notice), timeoutMs: PROMPT_TIMEOUT_MS });
        if (!answer.missing) {
            if (answer.exitCode === 0 && !answer.timedOut) {
                return zenityValueAnswer(answer.stdout, notice);
            }
            return answer.exitCode === 1 || answer.exitCode === 5 ? { kind: "cancelled" } : { kind: "unavailable", reason: `zenity could not ask (exit ${String(answer.exitCode ?? "none")})` };
        }
        return (await kdialogValue(runner, notice)) ?? { kind: "unavailable", reason: "neither zenity nor kdialog is installed" };
    };

// THE CHOICE DIALOG ON LINUX (consent.ts ChoicePrompt): an agent's need answered with one of a few buttons. zenity's
// list with one column, the first answer selected; kdialog's radio list where only kdialog is there. What comes back is
// the label picked, read back to its id.
export const zenityChoiceArgs = (notice: ChoiceNotice): readonly string[] => [
    "--list",
    "--radiolist",
    `--title=${notice.title}`,
    `--text=${markupText(notice.message)}`,
    "--column=",
    "--column=Answer",
    "--hide-header",
    ...notice.choices.flatMap((choice, at) => [at === 0 ? "TRUE" : "FALSE", choice.label]),
    `--timeout=${String(PROMPT_SECONDS)}`,
];

/** The id of the label a dialog answered, or undefined for one it did not offer. Pure. */
export const chosenId = (notice: ChoiceNotice, answered: string): string | undefined => notice.choices.find((choice) => choice.label === answered.replace(/\r?\n$/u, ""))?.id;

export const linuxChoicePrompt =
    (runner: Runner, env: NodeJS.ProcessEnv = process.env): ChoicePrompt =>
    async (notice) => {
        if ((env["DISPLAY"] ?? "") === "" && (env["WAYLAND_DISPLAY"] ?? "") === "") {
            return { kind: "unavailable", reason: "there is no display to show Passwords' choice on" };
        }
        const zenity = await runner({ command: "zenity", args: zenityChoiceArgs(notice), timeoutMs: PROMPT_TIMEOUT_MS });
        const answer = zenity.missing
            ? await runner({
                  command: "kdialog",
                  args: ["--title", notice.title, "--radiolist", notice.message, ...notice.choices.flatMap((choice, at) => [choice.label, choice.label, at === 0 ? "on" : "off"])],
                  timeoutMs: PROMPT_TIMEOUT_MS,
              })
            : zenity;
        if (answer.missing) {
            return { kind: "unavailable", reason: "neither zenity nor kdialog is installed" };
        }
        if (answer.exitCode !== 0 || answer.timedOut) {
            return { kind: "cancelled" };
        }
        const id = chosenId(notice, answer.stdout);
        return id === undefined ? { kind: "cancelled" } : { kind: "chosen", id };
    };
