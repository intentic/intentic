import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Runner, succeeded } from "../run.js";
import type { Inspected, Place, Seen, Typed, Typist } from "./typist.js";

// Typing on an Android phone attached over adb: the foreground app from `dumpsys window`, the focused node's
// `password` flag from a uiautomator dump, then `input text` / `input keyevent` commands, which `adb shell` reads from
// its standard input rather than from adb's command line. On the phone they run as one shell's commands, which the phone's
// own processes could list for the moment they run; that is the most adb offers.

const TIMEOUT_MS = 20_000;

// adb from the SDK the environment names, else whichever is on PATH.
export const adbPath = (env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): string => {
    const executable = platform === "win32" ? "adb.exe" : "adb";
    for (const root of [env["ANDROID_HOME"], env["ANDROID_SDK_ROOT"]]) {
        if (root !== undefined && root !== "") {
            const candidate = join(root, "platform-tools", executable);
            if (exists(candidate)) {
                return candidate;
            }
        }
    }
    return executable;
};

const FOCUS_LINE = /mCurrentFocus=Window\{[^}]*?\s(?<pkg>[A-Za-z][\w.]*)\/[^\s}]+/u;
const FOCUSED_APP = /mFocusedApp=(?:ActivityRecord|AppWindowToken)\{[^}]*?\s(?<pkg>[A-Za-z][\w.]*)\/[^\s}]+/u;

// The package of the app in front, from `dumpsys window`'s output.
export const foregroundPackage = (dumpsys: string): string | undefined =>
    FOCUS_LINE.exec(dumpsys)?.groups?.["pkg"] ?? FOCUSED_APP.exec(dumpsys)?.groups?.["pkg"];

// The focused node of a uiautomator dump: whether it is a password field, and the app it belongs to.
export const focusedNode = (dump: string): { readonly password: boolean; readonly pkg: string } | undefined => {
    const nodes = dump.match(/<node\b[^>]*>/gu) ?? [];
    const focused = nodes.findLast((node) => /\sfocused="true"/u.test(node));
    if (focused === undefined) {
        return undefined;
    }
    return { password: /\spassword="true"/u.test(focused), pkg: /\spackage="(?<pkg>[^"]*)"/u.exec(focused)?.groups?.["pkg"] ?? "" };
};

// ---- the commands that type a value: a copy of intentic-machine's android-parse.ts `inputTextCommand`, whose errors
// named the offending character; a refusal here must not carry any part of the value, so these say only what kind ----

const shellQuote = (text: string): string => `'${text.replace(/'/gu, `'\\''`)}'`;

const KEY_FOR_CONTROL = new Map([
    ["\n", "66"],
    ["\r", "66"],
    ["\t", "61"],
]);

type TypedPart = { readonly kind: "text"; readonly text: string } | { readonly kind: "key"; readonly code: string };

export class UntypableValue extends Error {
    constructor() {
        super("Android's `input text` types plain ASCII only, and this value holds a character outside it: type it on the phone's own keyboard.");
        this.name = "UntypableValue";
    }
}

const typedParts = (text: string): TypedPart[] => {
    const parts: TypedPart[] = [];
    let run = "";
    const flush = (): void => {
        if (run !== "") {
            parts.push({ kind: "text", text: run });
        }
        run = "";
    };
    // "\r\n" is one Enter, not two.
    const chars = [...text.replace(/\r\n/gu, "\n")];
    chars.forEach((char, index) => {
        const code = KEY_FOR_CONTROL.get(char);
        if (code !== undefined) {
            flush();
            parts.push({ kind: "key", code });
            return;
        }
        if (char < " " || char > "~") {
            throw new UntypableValue();
        }
        // `input text` reads "%s" as a space, so a literal one is split across two calls.
        if (char === "s" && chars[index - 1] === "%") {
            flush();
        }
        run += char;
    });
    flush();
    return parts;
};

// The phone-side commands that type `text`, joined with `&&` so a failure stops the rest: a space goes as %s, which is
// how `input text` carries one; a newline or tab is pressed as its key.
export const inputTextCommand = (text: string): string =>
    typedParts(text)
        .map((part) => (part.kind === "key" ? `input keyevent ${part.code}` : `input text ${shellQuote(part.text.replace(/ /gu, "%s"))}`))
        .join(" && ");

export const androidTypist = (runner: Runner, adb: string = adbPath()): Typist => {
    const front = async (serial: string): Promise<string | undefined> => {
        const answer = await runner({ command: adb, args: ["-s", serial, "shell", "dumpsys", "window"], timeoutMs: TIMEOUT_MS });
        return succeeded(answer) ? foregroundPackage(answer.stdout) : undefined;
    };
    const serialOf = (place: Place): string | undefined => (place.kind === "android" ? place.serial : undefined);
    return {
        inspect: async (place): Promise<Inspected> => {
            const serial = serialOf(place);
            if (serial === undefined) {
                return { ok: false, reason: "No phone was named." };
            }
            const pkg = await front(serial);
            if (pkg === undefined) {
                return { ok: false, reason: `adb could not name the app in front on ${serial}: is the phone attached and unlocked, and adb installed?` };
            }
            const dumped = await runner({ command: adb, args: ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"], timeoutMs: TIMEOUT_MS });
            const node = succeeded(dumped) ? focusedNode(dumped.stdout) : undefined;
            const field = node === undefined || node.pkg !== pkg ? "unknown" : node.password ? "password" : "text";
            return { ok: true, seen: { focus: { program: pkg, path: pkg, field }, handle: pkg } };
        },
        type: async (place, seen: Seen, value: string): Promise<Typed> => {
            const serial = serialOf(place);
            if (serial === undefined) {
                return { ok: false, reason: "No phone was named.", partly: false };
            }
            let commands: string;
            try {
                commands = inputTextCommand(value);
            } catch (error) {
                return { ok: false, reason: error instanceof UntypableValue ? error.message : "The value could not be put into typing commands.", partly: false };
            }
            if ((await front(serial)) !== seen.handle) {
                return { ok: false, reason: "Another app came to the front before typing began; nothing was typed.", partly: false };
            }
            const typed = await runner({ command: adb, args: ["-s", serial, "shell"], input: `${commands}\nexit\n`, timeoutMs: TIMEOUT_MS + value.length * 100 });
            if (!succeeded(typed)) {
                return { ok: false, reason: "adb could not type on the phone; some of the value may have gone in.", partly: true };
            }
            return (await front(serial)) === seen.handle
                ? { ok: true }
                : { ok: false, reason: "Another app came to the front while typing: some of the value may have gone there.", partly: true };
        },
    };
};
