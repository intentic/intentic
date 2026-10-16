import { readlink } from "node:fs/promises";
import { basenameOf } from "../policy.js";
import { type Runner, succeeded } from "../run.js";
import { noTypist, type Inspected, type Seen, type Typed, type Typist } from "./typist.js";

// Typing on Linux. X11: the active window and its process from xdotool, the executable from /proc/<pid>/exe, and the
// value through `xdotool type --file -`, read from standard input. Wayland: `wtype -`, which reads standard input too,
// but no Wayland compositor tells another program which window is focused, so the program is unknown and every entry
// asks the person (and a value a sandbox sent, which only a named program may receive, is refused). Neither can say
// whether the focused field is a password field: it reads as unknown, which policy treats as not one.

const TIMEOUT_MS = 10_000;
// xdotool types at its own pace, a dozen milliseconds a character.
const typingTimeout = (value: string): number => TIMEOUT_MS + value.length * 50;

export type LinuxSession = "x11" | "wayland" | "none";

export const linuxSession = (env: NodeJS.ProcessEnv): LinuxSession => {
    const wayland = env["XDG_SESSION_TYPE"] === "wayland" || ((env["WAYLAND_DISPLAY"] ?? "") !== "" && (env["DISPLAY"] ?? "") === "");
    if (wayland) {
        return "wayland";
    }
    return (env["DISPLAY"] ?? "") === "" ? "none" : "x11";
};

const activeWindow = async (runner: Runner): Promise<string | undefined> => {
    const answer = await runner({ command: "xdotool", args: ["getactivewindow"], timeoutMs: TIMEOUT_MS });
    const id = answer.stdout.trim();
    return succeeded(answer) && /^\d+$/u.test(id) ? id : undefined;
};

const x11Typist = (runner: Runner, exeOf: (pid: string) => Promise<string>): Typist => ({
    inspect: async (): Promise<Inspected> => {
        const window = await activeWindow(runner);
        if (window === undefined) {
            return { ok: false, reason: "xdotool could not name the active window: is xdotool installed, and is this an X11 session?" };
        }
        const pidAnswer = await runner({ command: "xdotool", args: ["getwindowpid", window], timeoutMs: TIMEOUT_MS });
        const owner = pidAnswer.stdout.trim();
        const path = succeeded(pidAnswer) && /^\d+$/u.test(owner) ? await exeOf(owner) : "";
        return { ok: true, seen: { focus: { program: path === "" ? "" : basenameOf(path), path, field: "unknown" }, handle: window } };
    },
    type: async (_place, seen: Seen, value: string): Promise<Typed> => {
        if ((await activeWindow(runner)) !== seen.handle) {
            return { ok: false, reason: "The focus moved to another window before typing began; nothing was typed.", partly: false };
        }
        const typed = await runner({ command: "xdotool", args: ["type", "--clearmodifiers", "--file", "-"], input: value, timeoutMs: typingTimeout(value) });
        if (!succeeded(typed)) {
            return { ok: false, reason: "xdotool could not type; some of the value may have gone in.", partly: true };
        }
        const after = await activeWindow(runner);
        return after === seen.handle
            ? { ok: true }
            : { ok: false, reason: "The focus moved to another window while typing: some of the value may have gone there.", partly: true };
    },
});

const waylandTypist = (runner: Runner): Typist => ({
    inspect: () => Promise.resolve({ ok: true, seen: { focus: { program: "", path: "", field: "unknown" }, handle: "wayland" } }),
    type: async (_place, _seen, value): Promise<Typed> => {
        const typed = await runner({ command: "wtype", args: ["-"], input: value, timeoutMs: typingTimeout(value) });
        if (typed.missing) {
            return { ok: false, reason: "wtype is not installed: install it to type into Wayland windows.", partly: false };
        }
        return succeeded(typed) ? { ok: true } : { ok: false, reason: "wtype could not type; some of the value may have gone in.", partly: true };
    },
});

const procExe = async (pid: string): Promise<string> => {
    try {
        return await readlink(`/proc/${pid}/exe`);
    } catch {
        // allow(silent-catch): a process this user may not read, or one gone since, leaves its program unnamed, which no list matches
        return "";
    }
};

export const linuxTypist = (runner: Runner, env: NodeJS.ProcessEnv = process.env, exeOf: (pid: string) => Promise<string> = procExe): Typist => {
    switch (linuxSession(env)) {
        case "x11":
            return x11Typist(runner, exeOf);
        case "wayland":
            return waylandTypist(runner);
        case "none":
            return noTypist("There is no desktop session to type into (neither DISPLAY nor WAYLAND_DISPLAY is set).");
    }
};
