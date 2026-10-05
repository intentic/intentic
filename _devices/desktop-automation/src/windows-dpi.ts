// Prepended to every PowerShell script that reads or moves the screen. powershell.exe is not DPI-aware, so on a
// scaled display Windows hands it a shrunken, virtualised desktop: a 4K monitor at 150% reads as 2560×1440,
// CopyFromScreen copies only that top-left part of it, and SetCursorPos lands somewhere else again. Declaring the
// process per-monitor aware (v2) before anything asks makes every call answer in physical pixels.
//
// Per-monitor v2 only, with no fallback, measured on a 4K-at-150% monitor beside a 1920×1200 one at 100%
// (2026-10-05): the older system-wide SetProcessDPIAware reads that desktop as 6720×2160, the second monitor blown
// up by the first one's scale, which is wrong in a new way rather than right; and Defender's script scanner
// rejected the script that carried both declarations beside a screen copy as malicious. A Windows older than
// 10 1703 has no per-monitor v2, and keeps the unaware behaviour it had before this line existed.
export const WINDOWS_DPI_AWARE = `
Add-Type -Namespace IntenticDpi -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);';
try { [void][IntenticDpi.Native]::SetProcessDpiAwarenessContext([System.IntPtr]::new(-4)) } catch { }; # // allow(silent-catch): a Windows older than 10 1703 keeps the unaware behaviour, as the note above says
`;
