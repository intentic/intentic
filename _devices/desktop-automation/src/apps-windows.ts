import { parseWindowsJson } from "./parse.js";
import { run } from "./run.js";
import { DesktopError, type WindowInfo } from "./types.js";

// Windows window listing and focus, via PowerShell calls into user32.
// EnumWindows is the source of truth, not Get-Process.MainWindowHandle: a process can own several visible windows.

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

// A minimised window must be restored (SW_RESTORE) before it can take focus.
const SW_RESTORE = 9;

// Polls until the window becomes foreground; only guards a slow window manager, not a normal wait.
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

    // SetForegroundWindow silently fails unless this process already owns the foreground; attaching input queues to the
    // target's thread earns it. Polls afterward to confirm focus actually landed.
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

    // Start-Process resolves an executable, document, or URL through the shell's own file associations.
    launch: async (target: string): Promise<void> => {
        await powershell(`Start-Process -FilePath ${JSON.stringify(target)};`);
    },

    // -Raw returns a multi-line clipboard as one string instead of an array of lines.
    readClipboard: async (): Promise<string> => await powershell("Get-Clipboard -Raw;"),

    writeClipboard: async (text: string): Promise<void> => {
        // A quoted literal avoids a temp file; single quotes are doubled, PowerShell's own escape.
        await powershell(`Set-Clipboard -Value '${text.replace(/'/g, "''")}';`);
    },
};
