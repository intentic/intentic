import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// A PROGRAM RUN INSIDE WINDOWS SANDBOX (app_start with `isolated`): a throwaway VM Windows Pro, Enterprise and Education
// carry, which starts clean, sees the build's folder read-only and one log folder it may write, and forgets everything
// when it closes. What it is for: a build from an agent that should not touch the owner's own profile, registry or files.
// What it costs: Windows Sandbox runs one at a time, takes ten or twenty seconds to boot, and is a VM window of its own,
// so the app's windows are inside it (screenshot the "Windows Sandbox" window; ui_elements cannot reach in).
//
// The VM is described by a .wsb file (https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file):
// the build folder mapped read-only at C:\app, the run's log folder writable at C:\intentic-log, and a logon command
// that runs start.ps1 from there: the program started with its output redirected, and its exit code written when it ends.

export const SANDBOX_APP_DIR = "C:\\app";
export const SANDBOX_LOG_DIR = "C:\\intentic-log";
// The Windows Sandbox client processes: what is running while a sandbox is open, and what a stop ends. The host
// service behind them (CmService, vmcompute) is Windows' own and never touched.
export const SANDBOX_CLIENTS = ["WindowsSandbox.exe", "WindowsSandboxClient.exe", "WindowsSandboxRemoteSession.exe"] as const;

export const windowsSandboxExe = (): string => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsSandbox.exe");

// Whether this machine can run one, and if not, the sentence that says why and what would change it.
export const windowsSandboxMissing = async (): Promise<string | undefined> => {
    if (process.platform !== "win32") {
        return "Isolated runs use Windows Sandbox, which only Windows has: start it without `isolated` here.";
    }
    const there = await stat(windowsSandboxExe()).then(
        () => true,
        () => false,
    );
    return there
        ? undefined
        : "Windows Sandbox is not turned on here. On Windows Pro, Enterprise or Education an administrator turns it on with `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All` and a restart (virtualization must be on in the firmware); Windows Home does not have it. Start it without `isolated` meanwhile.";
};

const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// A PowerShell single-quoted literal: nothing inside is expanded, and a quote is doubled.
export const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

export interface IsolatedSpec {
    // The folder on this machine holding the program, mapped read-only at C:\app.
    readonly appFolder: string;
    // The program's path relative to that folder.
    readonly program: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    // The run's own log folder on this machine, mapped writable at C:\intentic-log.
    readonly logFolder: string;
    readonly network: boolean;
}

// The .wsb that describes the VM.
export const wsbConfig = (spec: IsolatedSpec): string =>
    [
        "<Configuration>",
        `  <Networking>${spec.network ? "Enable" : "Disable"}</Networking>`,
        "  <ClipboardRedirection>Disable</ClipboardRedirection>",
        "  <PrinterRedirection>Disable</PrinterRedirection>",
        "  <AudioInput>Disable</AudioInput>",
        "  <VideoInput>Disable</VideoInput>",
        "  <MappedFolders>",
        "    <MappedFolder>",
        `      <HostFolder>${xml(spec.appFolder)}</HostFolder>`,
        `      <SandboxFolder>${SANDBOX_APP_DIR}</SandboxFolder>`,
        "      <ReadOnly>true</ReadOnly>",
        "    </MappedFolder>",
        "    <MappedFolder>",
        `      <HostFolder>${xml(spec.logFolder)}</HostFolder>`,
        `      <SandboxFolder>${SANDBOX_LOG_DIR}</SandboxFolder>`,
        "      <ReadOnly>false</ReadOnly>",
        "    </MappedFolder>",
        "  </MappedFolders>",
        "  <LogonCommand>",
        `    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${SANDBOX_LOG_DIR}\\start.ps1</Command>`,
        "  </LogonCommand>",
        "</Configuration>",
        "",
    ].join("\r\n");

// What runs at logon inside the VM: the program, its output into the log folder, its exit code when it ends.
export const startScript = (spec: IsolatedSpec): string => {
    const program = `${SANDBOX_APP_DIR}\\${spec.program.replace(/\//g, "\\")}`;
    const log = (name: string): string => psQuote(`${SANDBOX_LOG_DIR}\\${name}`);
    const args = spec.args.length === 0 ? "" : ` -ArgumentList @(${spec.args.map((arg) => psQuote(arg.includes(" ") ? `"${arg}"` : arg)).join(", ")})`;
    return [
        "$ErrorActionPreference = 'Stop'",
        ...Object.entries(spec.env).map(([key, value]) => `[Environment]::SetEnvironmentVariable(${psQuote(key)}, ${psQuote(value)}, 'Process')`),
        `Set-Content -Path ${log("started")} -Value (Get-Date -Format o)`,
        "try {",
        `  $p = Start-Process -FilePath ${psQuote(program)}${args} -WorkingDirectory ${psQuote(SANDBOX_APP_DIR)} -RedirectStandardOutput ${log("output.log")} -RedirectStandardError ${log("error.log")} -PassThru -Wait`,
        `  Set-Content -Path ${log("exit-code")} -Value $p.ExitCode`,
        "} catch {",
        `  Add-Content -Path ${log("error.log")} -Value $_.Exception.Message`,
        `  Set-Content -Path ${log("exit-code")} -Value 'start-failed'`,
        "}",
        "",
    ].join("\r\n");
};

// Whether a Windows Sandbox is open on this machine now (there is only ever one).
export const windowsSandboxRunning = async (): Promise<boolean> => {
    if (process.platform !== "win32") {
        return false;
    }
    const { stdout } = await exec("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const names = new Set(stdout.split(/\r?\n/).map((line) => line.split('","')[0]?.replace(/^"/, "").toLowerCase()));
    return SANDBOX_CLIENTS.some((name) => names.has(name.toLowerCase()));
};

// Closes it: the VM is discarded with everything in it.
export const stopWindowsSandbox = async (): Promise<void> => {
    for (const name of SANDBOX_CLIENTS) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- three names, one after another so the client goes first
        await exec("taskkill", ["/IM", name, "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    }
};

// What the program inside said about how it ended, read off the exit-code file the start script writes.
export const isolatedExit = (text: string | undefined): string | undefined => {
    const said = text?.trim();
    if (said === undefined || said === "") {
        return undefined;
    }
    return said === "start-failed" ? "the program could not be started inside the sandbox (see its error output)" : `the program inside ended with code ${said}`;
};
