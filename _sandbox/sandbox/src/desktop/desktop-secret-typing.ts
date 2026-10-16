import { readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";
import { runBounded } from "@intentic/base/process";
import { agentDesktop } from "./agent-desktop.js";

// Typing a stored secret into the window that has the keyboard on the sandbox's own desktop (secrets-tools.ts), the one
// place a value goes through xdotool. `xdotool type -- <text>` would put it in argv, where every process in the
// container reads it off /proc; `--file -` takes it on stdin instead, which only xdotool reads.

export interface FocusedDesktopWindow {
    // xdotool's window id, as it prints it: what the typing checks still has the keyboard right before it types.
    readonly window: string;
    // The program behind the window: its executable's file name, as the program guard lists programs.
    readonly program: string;
    readonly title: string;
}

export interface DesktopTypist {
    // The window with the keyboard now, undefined when none has it.
    readonly focused: () => Promise<FocusedDesktopWindow | undefined>;
    // Types into `window` only while it still has the keyboard: a card answered after the focus moved types nothing.
    readonly type: (window: string, value: string) => Promise<"typed" | "moved">;
}

const XDOTOOL = "/usr/bin/xdotool";
const READ_TIMEOUT_MS = 5_000;
// A long value at 12 ms a key, with room for a slow display.
const TYPE_TIMEOUT_MS = 30_000;

// What the typist runs programs with and reads the desktop off: the real ones, or a test's.
export interface DesktopTypistDeps {
    readonly run: typeof runBounded;
    readonly display: () => Promise<string>;
}

const REAL: DesktopTypistDeps = { run: runBounded, display: async () => (await agentDesktop()).display.name };

const xdotool = async (deps: DesktopTypistDeps, args: readonly string[], input?: string): Promise<string | undefined> => {
    const display = await deps.display();
    const result = await deps.run(XDOTOOL, args, {
        env: { ...process.env, DISPLAY: display },
        timeoutMs: input === undefined ? READ_TIMEOUT_MS : TYPE_TIMEOUT_MS,
        input,
    });
    return result.exitCode === 0 ? result.stdout.text.trim() : undefined;
};

// The executable behind a process, by its file name; its short name when the link cannot be read.
const programOf = async (pid: string): Promise<string | undefined> => {
    try {
        return basename(await readlink(`/proc/${pid}/exe`));
    } catch {
        // allow(silent-catch): a process the daemon may not inspect still names itself in comm.
        const comm = (await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")).trim();
        return comm === "" ? undefined : comm;
    }
};

export const sandboxDesktopTypist = (deps: DesktopTypistDeps = REAL): DesktopTypist => {
    const focused = async (): Promise<FocusedDesktopWindow | undefined> => {
        const window = await xdotool(deps, ["getactivewindow"]);
        if (window === undefined || !/^\d+$/u.test(window) || window === "0") {
            return undefined;
        }
        const [pid, title] = await Promise.all([xdotool(deps, ["getwindowpid", window]), xdotool(deps, ["getwindowname", window])]);
        const program = pid === undefined || !/^\d+$/u.test(pid) ? undefined : await programOf(pid);
        // A window that names no process (an X client of another host) has no program a guard could list.
        return program === undefined ? undefined : { window, program, title: title ?? "" };
    };
    return {
        focused,
        type: async (window, value) => {
            const now = await focused();
            if (now?.window !== window) {
                return "moved";
            }
            const typed = await xdotool(deps, ["type", "--clearmodifiers", "--delay", "12", "--file", "-"], value);
            if (typed === undefined) {
                throw new Error("the desktop did not take the keystrokes: xdotool failed");
            }
            return "typed";
        },
    };
};
