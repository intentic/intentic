# THE FOLDER THE ic CLI LANDS IN, PUT ON THE USER'S PATH - so the commands ic prints when it finishes are real
# commands rather than a promise the installer that made them cannot keep. The .sh twin gets this free with a symlink
# into ~/.local/bin; Windows has no such folder, so the user's own PATH is the only place to say it.
#
# HKCU\Environment is written DIRECTLY rather than through [Environment]::SetEnvironmentVariable, which stores the
# value back as REG_SZ: every %USERPROFILE%- or %PNPM_HOME%-style entry already in that PATH would stop expanding, and
# each tool behind one would vanish from the user's shell. Reading with DoNotExpandEnvironmentNames keeps them as
# tokens, and the value goes back under the kind it already had.
#
# Best-effort: PATH is the convenience, the install is the job. A device that refuses the edit is told where the
# binary is and keeps everything else.
function Add-IntenticPath {
    param([string]$Folder, [string]$Command)
    try {
        $key = Get-Item -Path 'HKCU:\Environment' -ErrorAction Stop
        $stored = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if (($stored -split ';') -notcontains $Folder) {
            $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
            $kept = @($stored -split ';' | Where-Object { $_ -ne '' })
            Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value (($kept + $Folder) -join ';') -Type $kind -ErrorAction Stop
            # Explorer hands every terminal it starts a COPY of the environment, taken when Explorer itself
            # started. Without this broadcast - the one the Control Panel's environment editor sends - the new
            # PATH would reach nothing until the next sign-in. SendMessageTimeout, so one wedged window on this
            # desktop cannot wedge an install.
            if (-not ('Intentic.Native' -as [type])) {
                $signature = '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr word, string text, uint flags, uint timeout, out UIntPtr answer);'
                Add-Type -Namespace 'Intentic' -Name 'Native' -MemberDefinition $signature -ErrorAction Stop
            }
            $answer = [UIntPtr]::Zero
            [void][Intentic.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$answer)
        }
        # This window has its own copy as well, and it is the one the user is looking at when the output tells them
        # what to run next.
        if (($env:Path -split ';') -notcontains $Folder) { $env:Path = "$env:Path;$Folder" }
    } catch {
        Write-IntenticWarn "$Folder could not be added to your PATH ($($_.Exception.Message)), so $Command runs from that folder until you add it."
    }
}
