import { parseWindowsJson } from "./parse.js";
import { run } from "./run.js";
import type { WindowInfo } from "./types.js";

/* Windows: what is open, what has focus, and getting things opened — all through PowerShell into user32, the
 * same route the pointer takes.
 *
 * `Get-Process` already knows every process with a main window and its title, which is most of the answer; the
 * P/Invoke is only for the two things it does not carry — the window's rectangle and which window is in front.
 * `-TypeDefinition` rather than `-MemberDefinition` because a RECT struct has to be declared alongside the
 * imports, and only the full form allows that. */

const SHIM = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IntenticWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@ -ErrorAction SilentlyContinue;
`;

// SW_RESTORE — a minimised window cannot take focus until it is restored, and "focus it" is what the caller
// meant whether or not the user had minimised it.
const SW_RESTORE = 9;

const LIST = `
$fg = [IntenticWin]::GetForegroundWindow();
$items = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | ForEach-Object {
  $r = New-Object IntenticWin+RECT;
  [void][IntenticWin]::GetWindowRect($_.MainWindowHandle, [ref]$r);
  [pscustomobject]@{
    id = [string]$_.MainWindowHandle; title = $_.MainWindowTitle; app = $_.ProcessName;
    x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top);
    focused = ($_.MainWindowHandle -eq $fg)
  }
});
ConvertTo-Json -Compress -Depth 3 -InputObject $items;
`;

const powershell = (script: string): Promise<string> => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${SHIM}${script}`]);

export const windowsApps = {
    windows: async (): Promise<WindowInfo[]> => parseWindowsJson((await powershell(LIST)).trim()),

    focusWindow: async (id: string): Promise<void> => {
        await powershell(
            `$h = [IntPtr]::new([int64]${JSON.stringify(id)}); ` +
                `if ([IntenticWin]::IsIconic($h)) { [void][IntenticWin]::ShowWindow($h, ${SW_RESTORE}) }; ` +
                `[void][IntenticWin]::SetForegroundWindow($h);`,
        );
    },

    /* `Start-Process` is the one verb for all of it: an executable name, a document, a URL — Windows resolves
     * each against the shell's own associations, which is exactly the behaviour "open this for me" means. */
    launch: async (target: string): Promise<void> => {
        await powershell(`Start-Process -FilePath ${JSON.stringify(target)};`);
    },

    // -Raw keeps a multi-line clipboard as one string instead of an array of lines.
    readClipboard: async (): Promise<string> => await powershell("Get-Clipboard -Raw;"),

    writeClipboard: async (text: string): Promise<void> => {
        // Through a here-string via stdin would need a temp file; a quoted literal is enough once single quotes
        // are doubled, which is PowerShell's own escape.
        await powershell(`Set-Clipboard -Value '${text.replace(/'/g, "''")}';`);
    },
};
