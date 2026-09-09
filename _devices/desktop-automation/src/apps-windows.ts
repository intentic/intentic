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
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, IntPtr extra);
  // Two declarations of one export: SPI_GETFOREGROUNDLOCKTIMEOUT writes the timeout THROUGH pvParam, and
  // SPI_SETFOREGROUNDLOCKTIMEOUT passes the new one IN it. One signature cannot spell both.
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool ReadSetting(uint action, uint param, ref uint value, uint notify);
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool WriteSetting(uint action, uint param, IntPtr value, uint notify);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@ -ErrorAction SilentlyContinue;
`;

// A minimised window must be restored (SW_RESTORE) before it can take focus.
const SW_RESTORE = 9;

// Foreground-lock timeout: while it is armed Windows refuses EVERY foreground change from a process that did not
// earn it, and the thread-input attachment below cannot outvote it. Zeroed for the duration of one focus call and
// put back after. SPIF_SENDCHANGE so the setting takes effect for this call rather than at the next login.
const SPI_GET_FOREGROUND_LOCK_TIMEOUT = 0x2000;
const SPI_SET_FOREGROUND_LOCK_TIMEOUT = 0x2001;
const SPIF_SENDCHANGE = 0x0002;

// A key-up for ALT with no key-down before it. "The process received the last input event" is one of the documented
// conditions under which SetForegroundWindow is honoured, and this is the cheapest way to satisfy it; a lone key-up
// is the half of the pair that no window reads as a press, so nothing on the desktop sees an ALT.
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x0002;

// Attempts of the whole attach-and-raise sequence, each followed by its own poll. More than one because the refusal
// is not always permanent: a window that is still mapping, or an app activating itself a moment after being asked
// to, loses the first round and wins the second. Budgeted well inside run.ts's 15s kill.
const FOCUS_ATTEMPTS = 3;
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

    // SetForegroundWindow silently fails unless this process already owns the foreground. Three conditions earn it and
    // this asks for all three: the input queues attached to the target's thread, the foreground-lock timeout down, and
    // the last input event this process's own. Polls afterward to confirm focus actually landed, and on refusal names
    // the window that kept it — "something is holding the foreground" is a guess this can just look up.
    focusWindow: async (id: string): Promise<void> => {
        const settled = await powershell(
            `$h = [IntPtr]::new([int64]${JSON.stringify(id)});
             if ([IntenticWin]::IsIconic($h)) { [void][IntenticWin]::ShowWindow($h, ${SW_RESTORE}) };
             [uint32]$lock = 0;
             $armed = [IntenticWin]::ReadSetting(${SPI_GET_FOREGROUND_LOCK_TIMEOUT}, 0, [ref]$lock, 0);
             if ($armed) { [void][IntenticWin]::WriteSetting(${SPI_SET_FOREGROUND_LOCK_TIMEOUT}, 0, [IntPtr]::Zero, ${SPIF_SENDCHANGE}) };
             try {
               for ($attempt = 0; $attempt -lt ${FOCUS_ATTEMPTS}; $attempt++) {
                 if ([IntenticWin]::GetForegroundWindow() -eq $h) { break };
                 [uint32]$ignored = 0;
                 $mine = [IntenticWin]::GetCurrentThreadId();
                 $queues = @(
                   [IntenticWin]::GetWindowThreadProcessId([IntenticWin]::GetForegroundWindow(), [ref]$ignored),
                   [IntenticWin]::GetWindowThreadProcessId($h, [ref]$ignored)
                 ) | Where-Object { $_ -ne 0 -and $_ -ne $mine } | Select-Object -Unique;
                 foreach ($queue in $queues) { [void][IntenticWin]::AttachThreadInput($mine, $queue, $true) };
                 try {
                   [IntenticWin]::keybd_event(${VK_MENU}, 0, ${KEYEVENTF_KEYUP}, [IntPtr]::Zero);
                   [void][IntenticWin]::BringWindowToTop($h);
                   [void][IntenticWin]::SetForegroundWindow($h);
                 } finally {
                   foreach ($queue in $queues) { [void][IntenticWin]::AttachThreadInput($mine, $queue, $false) };
                 }
                 for ($poll = 0; $poll -lt ${FOCUS_POLLS}; $poll++) {
                   if ([IntenticWin]::GetForegroundWindow() -eq $h) { break };
                   Start-Sleep -Milliseconds ${FOCUS_POLL_MS};
                 }
               }
             } finally {
               if ($armed) { [void][IntenticWin]::WriteSetting(${SPI_SET_FOREGROUND_LOCK_TIMEOUT}, 0, [IntPtr]::new([int64]$lock), ${SPIF_SENDCHANGE}) };
             }
             $fg = [IntenticWin]::GetForegroundWindow();
             $holder = 'nothing holds the foreground';
             if ($fg -ne [IntPtr]::Zero) {
               $held = [System.Text.StringBuilder]::new([IntenticWin]::GetWindowTextLength($fg) + 1);
               [void][IntenticWin]::GetWindowText($fg, $held, $held.Capacity);
               [uint32]$owner = 0;
               [void][IntenticWin]::GetWindowThreadProcessId($fg, [ref]$owner);
               $program = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName;
               $holder = $held.ToString() + ' [' + $program + ']';
             }
             if ($fg -eq $h) { Write-Output 'focused' } else { Write-Output ('holder=' + $holder) }`,
        );
        const answer = settled.trim();
        if (answer !== `focused`) {
            const holder = answer.startsWith(`holder=`) ? answer.slice(`holder=`.length) : `nothing this could read`;
            throw new DesktopError(
                `Windows would not give window ${id} the keyboard after ${FOCUS_ATTEMPTS} attempts: it is gone, or ${holder} would not let go ` +
                    `(a UAC prompt, a full-screen app, or a locked session).`,
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
