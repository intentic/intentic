import { parseWindowsJson } from "./parse.js";
import { run } from "./run.js";
import type { WindowInfo } from "./types.js";

/* Windows: what is open, what has focus, and getting things opened — all through PowerShell into user32, the
 * same route the pointer takes.
 *
 * EnumWindows is the source of truth, not Get-Process.MainWindowHandle. A process may own several top-level
 * windows (a workspace plus a dialog is the ordinary case), while MainWindowHandle deliberately returns only
 * one. Losing the rest makes callers answer "one window" when two are visibly mapped. The process lookup below
 * only supplies the app name after every HWND has already been found. `-TypeDefinition` rather than
 * `-MemberDefinition` because the delegate and RECT struct have to be declared alongside the imports. */

const SHIM = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class IntenticWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
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
$items = [System.Collections.Generic.List[object]]::new();
$callback = [IntenticWin+EnumWindowsProc] {
  param([IntPtr]$h, [IntPtr]$unused)
  if (-not [IntenticWin]::IsWindowVisible($h)) { return $true }
  $length = [IntenticWin]::GetWindowTextLength($h);
  if ($length -le 0) { return $true }
  $text = [System.Text.StringBuilder]::new($length + 1);
  [void][IntenticWin]::GetWindowText($h, $text, $text.Capacity);
  if ($text.Length -eq 0) { return $true }
  [uint32]$processId = 0;
  [void][IntenticWin]::GetWindowThreadProcessId($h, [ref]$processId);
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue;
  $app = if ($process) { $process.ProcessName } else { '' };
  $r = New-Object IntenticWin+RECT;
  [void][IntenticWin]::GetWindowRect($h, [ref]$r);
  $items.Add([pscustomobject]@{
    id = [string]($h.ToInt64()); title = $text.ToString(); app = $app;
    x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top);
    focused = ($h -eq $fg)
  });
  return $true
};
[void][IntenticWin]::EnumWindows($callback, [IntPtr]::Zero);
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
