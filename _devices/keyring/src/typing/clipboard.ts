import { z } from "zod";
import { runPowerShell } from "../powershell.js";
import { type Runner, succeeded } from "../run.js";
import { linuxSession } from "./linux.js";

// THE CLIPBOARD, for the Passwords app's Copy: the keyring puts a value there itself (the app never holds it) and takes
// it off again after a while, but only if it is still what the keyring put there, so something the person copied since
// is left alone. The value goes to the platform's tool on standard input, never on a command line; reading it back for
// the comparison happens here, in the keyring, and the read value goes nowhere else.

const TIMEOUT_MS = 10_000;

export type ClipboardWrite = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface Clipboard {
    readonly write: (value: string) => Promise<ClipboardWrite>;
    // Empties the clipboard if it still holds `value`.
    readonly clearIf: (value: string) => Promise<void>;
}

const unavailable = (reason: string): Clipboard => ({ write: () => Promise.resolve({ ok: false, reason }), clearIf: () => Promise.resolve() });

const WINDOWS_SET = `
$ErrorActionPreference = 'Stop'
try { Set-Clipboard -Value $KeyringInput.value; [Console]::Out.WriteLine('intentic-keyring>{"ok":true}') } catch { [Console]::Out.WriteLine('intentic-keyring>{"ok":false}') }
`;
const WINDOWS_CLEAR = `
$ErrorActionPreference = 'Stop'
try { if ((Get-Clipboard -Raw) -ceq $KeyringInput.value) { Set-Clipboard -Value $null }; [Console]::Out.WriteLine('intentic-keyring>{"ok":true}') } catch { [Console]::Out.WriteLine('intentic-keyring>{"ok":false}') }
`;
const DoneSchema = z.object({ ok: z.boolean() });

const windowsClipboard = (runner: Runner): Clipboard => ({
    write: async (value) => {
        const ran = await runPowerShell(runner, { script: WINDOWS_SET, input: { value }, timeoutMs: TIMEOUT_MS }, DoneSchema);
        return ran.ok && ran.answer.ok ? { ok: true } : { ok: false, reason: "Windows did not take the value onto the clipboard." };
    },
    clearIf: async (value) => {
        await runPowerShell(runner, { script: WINDOWS_CLEAR, input: { value }, timeoutMs: TIMEOUT_MS }, DoneSchema);
    },
});

interface LinuxTool {
    readonly set: { readonly command: string; readonly args: readonly string[] };
    readonly get: { readonly command: string; readonly args: readonly string[] };
    readonly clear: { readonly command: string; readonly args: readonly string[]; readonly input?: string };
}

const WAYLAND: LinuxTool = { set: { command: "wl-copy", args: [] }, get: { command: "wl-paste", args: ["--no-newline"] }, clear: { command: "wl-copy", args: ["--clear"] } };
const X11: LinuxTool = {
    set: { command: "xclip", args: ["-selection", "clipboard"] },
    get: { command: "xclip", args: ["-selection", "clipboard", "-o"] },
    clear: { command: "xclip", args: ["-selection", "clipboard"], input: "" },
};

const linuxClipboard = (runner: Runner, tool: LinuxTool): Clipboard => ({
    write: async (value) => {
        const done = await runner({ ...tool.set, input: value, timeoutMs: TIMEOUT_MS });
        if (done.missing) {
            return { ok: false, reason: `${tool.set.command} is not installed: install it for Copy to work.` };
        }
        return succeeded(done) ? { ok: true } : { ok: false, reason: `${tool.set.command} could not take the value onto the clipboard.` };
    },
    clearIf: async (value) => {
        const now = await runner({ ...tool.get, timeoutMs: TIMEOUT_MS });
        if (succeeded(now) && now.stdout === value) {
            await runner({ ...tool.clear, input: tool.clear.input ?? "", timeoutMs: TIMEOUT_MS });
        }
    },
});

/** This computer's clipboard, as Copy reaches it. */
export const platformClipboard = (runner: Runner, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Clipboard => {
    if (platform === "win32") {
        return windowsClipboard(runner);
    }
    if (platform === "linux") {
        const session = linuxSession(env);
        return session === "none" ? unavailable("There is no desktop session with a clipboard here.") : linuxClipboard(runner, session === "wayland" ? WAYLAND : X11);
    }
    return unavailable(`The keyring cannot reach the clipboard on ${platform}.`);
};
