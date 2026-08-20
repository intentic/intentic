/* Installing, starting and stopping the thing under test.
 *
 * Everything here DISCOVERS rather than assumes. The install location comes from the registry, the executable
 * comes from listing the install directory, the uninstaller comes from the `UninstallString` Windows itself
 * recorded. The alternative, hardcoding `%LOCALAPPDATA%\Intentic\Intentic.exe`, is a tier that keeps
 * passing when the bundler renames something and keeps failing when it does not, because "the path I guessed
 * is not there" and "the install did nothing" produce the same missing file.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { powershell, type RunResult } from "./run.js";

/** How long an install may take. Generous because it may fetch the WebView2 runtime on a machine without one. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1_000;

/* Silent install through `Start-Process -Wait`, not by executing the installer directly.
 *
 * NSIS's `/S` returns control to the caller before the install has finished whenever the installer hands off to
 * a second process, which Tauri's does when the WebView2 bootstrapper has to run. A direct spawn therefore
 * exits 0 onto a machine where nothing is installed yet, and every assertion after it fails naming the wrong
 * thing. `-Wait` waits for the whole tree; `-PassThru` is what makes an exit code available at all.
 */
export const installSilently = async (installer: string): Promise<RunResult> =>
    await powershell(
        `$p = Start-Process -FilePath '${installer}' -ArgumentList '/S' -Wait -PassThru
         Write-Output $p.ExitCode
         exit $p.ExitCode`,
        { timeoutMs: INSTALL_TIMEOUT_MS },
    );

/* The uninstall, run the way Windows itself recorded it.
 *
 * `UninstallString` is a command line, not a path, it may carry arguments and may or may not be quoted, so it
 * is handed back to a shell that knows how to read one rather than being split here. `/S` is appended for the
 * silent run; the app's own pre-uninstall hook ends a running instance first, which is the behaviour this
 * exercises (the tray is where the app lives once its window is closed, so "running with nothing on screen" is
 * the ordinary state at uninstall time).
 */
export const uninstallSilently = async (uninstallString: string): Promise<RunResult> =>
    await powershell(
        `$p = Start-Process -FilePath '${uninstallString.replace(/^"|"$/g, ``)}' -ArgumentList '/S' -Wait -PassThru
         Write-Output $p.ExitCode
         exit $p.ExitCode`,
        { timeoutMs: INSTALL_TIMEOUT_MS },
    );

/** The app's own executable inside an install directory, everything but the uninstaller. */
export const appExecutable = async (installLocation: string): Promise<string | undefined> => {
    const entries = await readdir(installLocation, { withFileTypes: true });
    const executable = entries.find(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(`.exe`) && !entry.name.toLowerCase().startsWith(`uninstall`),
    );
    return executable === undefined ? undefined : join(installLocation, executable.name);
};

/* Start the app the way a person does, through the shell, detached, with this process not waiting on it.
 *
 * `-WindowStyle Hidden` applies to the PowerShell that starts it and not to the app, which manages its own
 * window; without it a console flashes on the CI desktop and can take focus off the window an assertion is
 * about to press Return into.
 */
export const launchApp = async (executable: string): Promise<RunResult> =>
    await powershell(`Start-Process -FilePath '${executable}' -WindowStyle Hidden`);

/** Whether any process is running from this executable. Matched on the image path, so a same-named app elsewhere is not it. */
export const appRunning = async (executable: string): Promise<boolean> => {
    const result = await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         $found = Get-Process | Where-Object { $_.Path -eq '${executable}' }
         if ($found) { Write-Output 'true' } else { Write-Output 'false' }`,
    );
    return result.stdout.trim() === `true`;
};

/* End every process running from this executable, and answer once none is left.
 *
 * Asserted rather than assumed by the caller, because it is the precondition the COLD link tiers rest on: every
 * assertion in this package reads window titles, and a setup screen left over from the phase before satisfies
 * the next search instantly, so a cold-start tier that never actually started anything cold reports a pass.
 * The Linux tier says the same thing at the top of its own `quit_app`.
 */
export const quitApp = async (executable: string): Promise<void> => {
    await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         Get-Process | Where-Object { $_.Path -eq '${executable}' } | Stop-Process -Force`,
    );
};
