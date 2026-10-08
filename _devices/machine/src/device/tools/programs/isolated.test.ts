import { isolatedExit, psQuote, SANDBOX_APP_DIR, SANDBOX_LOG_DIR, startScript, windowsSandboxMissing, wsbConfig } from "./isolated.js";

// What Windows Sandbox is handed for an isolated run: the build's folder read-only, the run's log folder writable, a
// logon command that starts the program with its output captured and its exit code kept; nothing more of the machine.

const spec = {
    appFolder: "C:\\Users\\me\\.intentic\\machine\\runs\\sb\\desktop\\600172f70409",
    program: "bin/intentic desktop.exe",
    args: ["--flag", "two words", "it's"],
    env: { RUST_LOG: "debug" },
    logFolder: "C:\\Users\\me\\.intentic\\machine\\runs\\sb\\.logs\\desktop-abc123",
    network: false,
};

test("the .wsb maps the build read-only and the log folder writable, and turns the rest off", () => {
    const wsb = wsbConfig(spec);
    expect(wsb).toContain(`<HostFolder>${spec.appFolder}</HostFolder>\r\n      <SandboxFolder>${SANDBOX_APP_DIR}</SandboxFolder>\r\n      <ReadOnly>true</ReadOnly>`);
    expect(wsb).toContain(`<HostFolder>${spec.logFolder}</HostFolder>\r\n      <SandboxFolder>${SANDBOX_LOG_DIR}</SandboxFolder>\r\n      <ReadOnly>false</ReadOnly>`);
    expect(wsb).toContain("<Networking>Disable</Networking>");
    expect(wsb).toContain("<ClipboardRedirection>Disable</ClipboardRedirection>");
    expect(wsb).toContain(`-File ${SANDBOX_LOG_DIR}\\start.ps1`);
    expect(wsbConfig({ ...spec, appFolder: "C:\\a&b<c>" })).toContain("<HostFolder>C:\\a&amp;b&lt;c&gt;</HostFolder>");
});

test("the start script runs the program from the mapped folder, quotes what it is given, and keeps its exit code", () => {
    const script = startScript(spec);
    expect(script).toContain(`-FilePath 'C:\\app\\bin\\intentic desktop.exe'`);
    expect(script).toContain(`-ArgumentList @('--flag', '"two words"', 'it''s')`);
    expect(script).toContain(`[Environment]::SetEnvironmentVariable('RUST_LOG', 'debug', 'Process')`);
    expect(script).toContain(`-RedirectStandardOutput 'C:\\intentic-log\\output.log'`);
    expect(script).toContain(`Set-Content -Path 'C:\\intentic-log\\exit-code' -Value $p.ExitCode`);
    expect(psQuote("a'b")).toBe("'a''b'");
});

test("what the program inside said about its end is read back in words", () => {
    expect(isolatedExit(undefined)).toBeUndefined();
    expect(isolatedExit("  \r\n")).toBeUndefined();
    expect(isolatedExit("0\r\n")).toBe("the program inside ended with code 0");
    expect(isolatedExit("start-failed")).toContain("could not be started");
});

test("off Windows, an isolated run is refused with what would make it possible", async () => {
    if (process.platform !== "win32") {
        expect(await windowsSandboxMissing()).toContain("only Windows has");
    }
});
