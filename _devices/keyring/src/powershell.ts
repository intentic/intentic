import type { z } from "zod";
import type { Runner } from "./run.js";

// Windows PowerShell 5.1 as the keyring runs it: for Windows Hello, a credential prompt, UI Automation and SendInput,
// which it reaches through WinRT and Add-Type C# without a native module of its own. The command line is a constant
// bootstrap; the script AND its input arrive together on standard input as one JSON document, so a value to type, a
// passphrase prompt's answer or a Hello challenge never ride argv. `-Command -` is not used: it reads standard input
// line by line as typed input, and a multi-line Add-Type here-string then does nothing at all (seen on Windows 11,
// PowerShell 5.1.26100). `$pid` is a read-only automatic variable there, so no script names one.

export const POWERSHELL = "powershell.exe";
const BOOTSTRAP = "$p = [Console]::In.ReadToEnd() | ConvertFrom-Json; $KeyringInput = $p.input; Invoke-Expression $p.script";
export const POWERSHELL_ARGS: readonly string[] = ["-NoProfile", "-NonInteractive", "-Command", BOOTSTRAP];

// The one line a helper's answer is printed on, found among whatever else PowerShell wrote.
export const ANSWER_MARK = "intentic-keyring>";

// Standard input is read in the console's code page, not UTF-8: JSON with every character past ASCII escaped reads
// the same in any of them.
export const asciiJson = (json: string): string =>
    // Matched by code point (the `u` flag), then written as its UTF-16 units: a character past U+FFFF is two `\u`
    // escapes, which JSON reads back as one. Seen on Windows 11: an emoji sent raw arrived as its UTF-8 bytes in CP437.
    json.replace(/[^\u0000-\u007e]/gu, (character) =>
        Array.from({ length: character.length }, (_unit, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`).join(""),
    );

// A C# helper's JSON string writer, for scripts that answer with text of their own (a path, a class name): every
// character past ASCII escaped, for the same reason as above.
export const CSHARP_JSON = `
public static class KeyringJson {
  public static string Str(string s) {
    if (s == null) return "null";
    System.Text.StringBuilder b = new System.Text.StringBuilder("\\"");
    foreach (char c in s) {
      if (c == '"') b.Append("\\\\\\"");
      else if (c == '\\\\') b.Append("\\\\\\\\");
      else if (c < 0x20 || c > 0x7e) b.AppendFormat("\\\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
}
`;

export interface PowerShellRun {
    readonly script: string;
    // What the script reads as $KeyringInput.
    readonly input: object;
    readonly timeoutMs: number;
}

export type PowerShellAnswer<T> = { readonly ok: true; readonly answer: T } | { readonly ok: false; readonly reason: string };

// Runs `script` and parses the line it marked with ANSWER_MARK. A script that printed no such line failed, whatever its
// exit code: PowerShell exits 0 after an error it only printed.
export const runPowerShell = async <T>(runner: Runner, run: PowerShellRun, schema: z.ZodType<T>): Promise<PowerShellAnswer<T>> => {
    const result = await runner({
        command: POWERSHELL,
        args: POWERSHELL_ARGS,
        input: asciiJson(JSON.stringify({ script: run.script, input: run.input })),
        timeoutMs: run.timeoutMs,
    });
    if (result.missing) {
        return { ok: false, reason: "Windows PowerShell (powershell.exe) was not found" };
    }
    if (result.timedOut) {
        return { ok: false, reason: `PowerShell did not finish within ${String(Math.round(run.timeoutMs / 1000))} s` };
    }
    const marked = result.stdout.split(/\r?\n/u).findLast((line) => line.startsWith(ANSWER_MARK));
    if (marked === undefined) {
        const said = result.stderr.split(/\r?\n/u).find((line) => line.trim() !== "")?.trim();
        return { ok: false, reason: said === undefined ? "PowerShell ended without an answer" : `PowerShell: ${said.slice(0, 200)}` };
    }
    let parsed: z.ZodSafeParseResult<T>;
    try {
        parsed = schema.safeParse(JSON.parse(marked.slice(ANSWER_MARK.length)));
    } catch {
        return { ok: false, reason: "PowerShell answered with something that is not JSON" };
    }
    return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: "PowerShell answered with something this keyring does not read" };
};

// The awaiting of a WinRT IAsyncOperation from Windows PowerShell, which cannot `await`: the AsTask extension made
// generic for the operation's result type, waited on. Verified on Windows 11 with PowerShell 5.1.
export const WINRT_AWAIT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
`;
