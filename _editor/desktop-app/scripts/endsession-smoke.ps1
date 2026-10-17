# Run in a disposable Windows desktop session:
#   pwsh -File scripts/endsession-smoke.ps1 -Executable 'C:\path\intentic-desktop.exe'
# The optional installer is for CI: install, test, then uninstall before the ordinary installer tier.
# WM_ENDSESSION is exactly what Restart Manager sends; it does not sign the machine out.
[CmdletBinding(DefaultParameterSetName = 'Executable')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Executable')][string]$Executable,
    [Parameter(Mandatory, ParameterSetName = 'Installer')][string]$Installer
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class EndSessionWindow {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
}
'@
$installed = $null
$app = $null
$originalUpdateCheck = $env:INTENTIC_DISABLE_UPDATE_CHECK
$originalConsent = $null
$consent = Join-Path $env:APPDATA 'dev.intentic.desktop\analytics-consent'
$hadConsent = Test-Path -LiteralPath $consent
try {
    if ($Installer) {
        $existing = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
            Where-Object DisplayName -eq 'Intentic'
        if ($existing) { throw 'Installer smoke requires a clean test profile with Intentic uninstalled' }
        $install = Start-Process -FilePath (Resolve-Path -LiteralPath $Installer).Path -ArgumentList '/S' -Wait -PassThru
        if ($install.ExitCode -ne 0) { throw "Installer exited $($install.ExitCode)" }
        $installed = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
            Where-Object DisplayName -eq 'Intentic' | Select-Object -First 1
        if (-not $installed) { throw 'Installer did not register Intentic' }
        $Executable = (Get-ChildItem -LiteralPath $installed.InstallLocation.Trim('"') -Filter '*.exe' |
            Where-Object { $_.Name -notmatch '^(uninstall|intentic-files|intentic-ic)' } | Select-Object -First 1).FullName
    }
    $Executable = (Resolve-Path -LiteralPath $Executable).Path
    # By name, not by every process's Path: Path is unreadable for protected processes and noisy under -Stop.
    if (Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($Executable)) -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $Executable }) { throw 'Close the existing app before this test' }
    $crash = Join-Path $env:APPDATA 'dev.intentic.desktop\crash.json'
    # Refuse old evidence instead of deleting it and making this launch appear clean.
    if (Test-Path -LiteralPath $crash) { throw "Existing crash evidence at $crash; use a clean test profile" }
    if ($hadConsent) { $originalConsent = [IO.File]::ReadAllText($consent) }
    [void][IO.Directory]::CreateDirectory((Split-Path $consent))
    [IO.File]::WriteAllText($consent, 'deny')
    $env:INTENTIC_DISABLE_UPDATE_CHECK = '1'
    $app = Start-Process -FilePath $Executable -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $target = [IntPtr]::Zero
    do {
        if ($app.HasExited) { throw "App exited before its event target was ready: $($app.ExitCode)" }
        $window = [IntPtr]::Zero
        do {
            $window = [EndSessionWindow]::FindWindowExW([IntPtr]::Zero, $window, 'Tao Thread Event Target', $null)
            if ($window -ne [IntPtr]::Zero) {
                [uint32]$ownerId = 0
                [void][EndSessionWindow]::GetWindowThreadProcessId($window, [ref]$ownerId)
                if ($ownerId -eq $app.Id) { $target = $window; break }
            }
        } while ($window -ne [IntPtr]::Zero)
        if ($target -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
    } while ($target -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
    if ($target -eq [IntPtr]::Zero) { throw 'No Tao Thread Event Target belonging to the launched process' }
    # Wait until setup has completed: the target is created before Tauri installs its RunEvent callback.
    $marker = Join-Path $env:APPDATA 'dev.intentic.desktop\launch.json'
    do {
        if ($app.HasExited) { throw 'App exited during startup' }
        $stage = $null
        # A marker from an earlier run of the app is not this launch's: only ours counts, by pid.
        try {
            $current = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
            if ($current.pid -eq $app.Id) { $stage = $current.stage }
        } catch { }
        if ($stage -notin @('window', 'shown')) { Start-Sleep -Milliseconds 100 }
    } while ($stage -notin @('window', 'shown') -and [DateTime]::UtcNow -lt $deadline)
    if ($stage -notin @('window', 'shown')) { throw 'App never completed startup' }
    $result = [UIntPtr]::Zero
    # TRUE + ENDSESSION_CLOSEAPP, SMTO_ABORTIFHUNG. The receiver may exit before sending a reply.
    [void][EndSessionWindow]::SendMessageTimeoutW($target, 0x16, [UIntPtr]1, [IntPtr]1, 0x2, 10000, [ref]$result)
    if (-not $app.WaitForExit(15000)) { throw 'WM_ENDSESSION left the app running' }
    if ($app.ExitCode -ne 0) { throw "WM_ENDSESSION exited $($app.ExitCode)" }
    if (Test-Path -LiteralPath $crash) { throw "WM_ENDSESSION wrote $crash" }
    $last = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($last.pid -ne $app.Id -or $last.stage -ne 'exited' -or $last.exitCause -ne 'session-end') { throw 'Exit cleanup did not record session-end' }
    Write-Output 'WM_ENDSESSION: clean exit, session-end recorded, no crash.json'
} finally {
    if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force }
    $env:INTENTIC_DISABLE_UPDATE_CHECK = $originalUpdateCheck
    if ($hadConsent -and $null -ne $originalConsent) { [IO.File]::WriteAllText($consent, $originalConsent) }
    elseif (-not $hadConsent) { Remove-Item -LiteralPath $consent -ErrorAction SilentlyContinue }
    if ($installed) {
        $uninstall = Start-Process -FilePath $installed.UninstallString.Trim('"') -ArgumentList '/S' -Wait -PassThru
        if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited $($uninstall.ExitCode)" }
    }
}
