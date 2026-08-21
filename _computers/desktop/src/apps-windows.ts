import { parseWindowsJson } from "./parse.js";
import { run } from "./run.js";
import { DesktopError, type WindowInfo } from "./types.js";

/* Windows: what is open, what has focus, and getting things opened, all through PowerShell into user32, the
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
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@ -ErrorAction SilentlyContinue;
`;

// SW_RESTORE, a minimised window cannot take focus until it is restored, and "focus it" is what the caller
// meant whether or not the user had minimised it.
const SW_RESTORE = 9;

// The activation is synchronous when it is allowed at all, so this is a guard against a slow window manager
// rather than a wait anything normally spends: it exits the moment the foreground is the window asked for.
const FOCUS_POLLS = 20;
const FOCUS_POLL_MS = 50;

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

    /* WHY THIS IS NOT ONE `SetForegroundWindow` CALL.
     *
     * Windows refuses that call from a process that is not already the foreground one. It does not fail loudly:
     * it returns false, flashes the window's taskbar button, and leaves the keyboard exactly where it was, so
     * the caller's next `type` or `key` is delivered to whatever the person at that desk had open. That is the
     * worst shape a failure can take here, and it is the ordinary case rather than an edge one: this backend
     * runs from a fresh `powershell.exe` that has never been in the foreground and never received an input
     * event, which is every qualifying condition missed at once. A machine whose foreground-lock timeout has
     * been raised, gaming and "stop apps stealing focus" utilities do this, and it is what one of our own CI
     * runners has, closes the last of them permanently.
     *
     * ATTACHING THE INPUT QUEUES IS WHAT EARNS THE RIGHT. While this thread shares an input queue with the
     * thread that owns the foreground, Windows counts it as the foreground process and honours the call; the
     * target's own queue joins too, so a modal dialog owned by another thread is reachable on the same terms.
     * Both attachments are undone immediately, an input queue left attached couples this process's message
     * loop to a stranger's for as long as it lives.
     *
     * THEN IT CHECKS. "Focus it" is a precondition, not a request: a caller that types into the window it
     * believes it focused has no way to discover it was wrong, so the one place that CAN tell says so here. */
    focusWindow: async (id: string): Promise<void> => {
        const settled = await powershell(
            `$h = [IntPtr]::new([int64]${JSON.stringify(id)});
             if ([IntenticWin]::IsIconic($h)) { [void][IntenticWin]::ShowWindow($h, ${SW_RESTORE}) };
             if ([IntenticWin]::GetForegroundWindow() -ne $h) {
               [uint32]$ignored = 0;
               $mine = [IntenticWin]::GetCurrentThreadId();
               $queues = @(
                 [IntenticWin]::GetWindowThreadProcessId([IntenticWin]::GetForegroundWindow(), [ref]$ignored),
                 [IntenticWin]::GetWindowThreadProcessId($h, [ref]$ignored)
               ) | Where-Object { $_ -ne 0 -and $_ -ne $mine } | Select-Object -Unique;
               foreach ($queue in $queues) { [void][IntenticWin]::AttachThreadInput($mine, $queue, $true) };
               try {
                 [void][IntenticWin]::BringWindowToTop($h);
                 [void][IntenticWin]::SetForegroundWindow($h);
               } finally {
                 foreach ($queue in $queues) { [void][IntenticWin]::AttachThreadInput($mine, $queue, $false) };
               }
             }
             for ($poll = 0; $poll -lt ${FOCUS_POLLS}; $poll++) {
               if ([IntenticWin]::GetForegroundWindow() -eq $h) { Write-Output 'focused'; break };
               Start-Sleep -Milliseconds ${FOCUS_POLL_MS};
             }`,
        );
        if (settled.trim() !== `focused`) {
            throw new DesktopError(
                `Windows would not give window ${id} the keyboard: it is gone, or something is holding the foreground (a UAC prompt, a full-screen app, or a locked session).`,
            );
        }
    },

    /* `Start-Process` is the one verb for all of it: an executable name, a document, a URL. Windows resolves
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
