import { z } from "zod";
import { basenameOf } from "../policy.js";
import { type Runner, succeeded } from "../run.js";
import type { Inspected, Seen, Typed, Typist } from "./typist.js";

// Typing on macOS through System Events: the frontmost application's bundle path and process id, then a `keystroke` of
// the value, the script (value included) on osascript's standard input. macOS does not tell another program whether
// the focused field is a secure text field without the accessibility tree, so the field reads as unknown. System Events
// needs the Accessibility permission for whichever program started the keyring, and says so in its error when it lacks it.

const TIMEOUT_MS = 15_000;

const FRONTMOST = [
    `tell application "System Events"`,
    `set p to first application process whose frontmost is true`,
    `return (unix id of p as text) & linefeed & POSIX path of (application file of p)`,
    `end tell`,
].join("\n");

const FrontmostSchema = z.object({ pid: z.string().regex(/^\d+$/u), path: z.string() });

// AppleScript's string literal: a backslash and a double quote are its only syntax.
const appleScriptText = (text: string): string => `"${text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;

export const keystrokeScript = (pid: string, value: string): string =>
    [
        `tell application "System Events"`,
        `set p to first application process whose frontmost is true`,
        `if (unix id of p as text) is not "${pid}" then error "moved"`,
        `keystroke ${appleScriptText(value)}`,
        `end tell`,
    ].join("\n");

export const macTypist = (runner: Runner): Typist => ({
    inspect: async (): Promise<Inspected> => {
        const answer = await runner({ command: "osascript", args: ["-"], input: FRONTMOST, timeoutMs: TIMEOUT_MS });
        const [pid, path] = answer.stdout.trim().split("\n");
        const front = FrontmostSchema.safeParse({ pid, path: path?.replace(/\/$/u, "") });
        if (!succeeded(answer) || !front.success) {
            return { ok: false, reason: "System Events did not name the frontmost app: allow the keyring under Privacy & Security, Accessibility." };
        }
        return { ok: true, seen: { focus: { program: basenameOf(front.data.path), path: front.data.path, field: "unknown" }, handle: front.data.pid } };
    },
    type: async (_place, seen: Seen, value: string): Promise<Typed> => {
        const typed = await runner({ command: "osascript", args: ["-"], input: keystrokeScript(seen.handle, value), timeoutMs: TIMEOUT_MS + value.length * 50 });
        if (succeeded(typed)) {
            return { ok: true };
        }
        return /moved/u.test(typed.stderr)
            ? { ok: false, reason: "The focus moved to another app before typing began; nothing was typed.", partly: false }
            : { ok: false, reason: "System Events could not type: allow the keyring under Privacy & Security, Accessibility.", partly: false };
    },
});
