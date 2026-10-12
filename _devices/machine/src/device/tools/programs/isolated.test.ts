import { psText } from "@intentic/desktop-automation";
import { isolatedExit, SANDBOX_APP_DIR, SANDBOX_LOG_DIR, startScript, windowsSandboxMissing, wsbConfig } from "./isolated.js";

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
    expect(script).toContain(`-FilePath ${psText("C:\\app\\bin\\intentic desktop.exe")} -ArgumentList`);
    expect(script).toContain(` -WorkingDirectory 'C:\\app' `);
    expect(script).toContain(`-ArgumentList @(${psText("--flag")}, ${psText('"two words"')}, ${psText("it's")})`);
    expect(script).toContain(`[Environment]::SetEnvironmentVariable(${psText("RUST_LOG")}, ${psText("debug")}, 'Process')`);
    expect(script).toContain(`-RedirectStandardOutput 'C:\\intentic-log\\output.log'`);
    expect(script).toContain(`Set-Content -Path 'C:\\intentic-log\\exit-code' -Value $p.ExitCode`);
});

// PowerShell ends a single-quoted literal at ‘ ’ ‚ ‛ as well as at ', so a doubled-ASCII literal let an agent's argument
// run code inside the VM. What the agent chose reaches the script only as base64.
test("the start script carries the agent's program, arguments and environment as data, typographic quotes included", () => {
    const hostile = "x’); calc; (‘y";
    const script = startScript({ ...spec, program: `bin/${hostile}.exe`, args: [hostile, "it's ‘quoted’"], env: { [`K${hostile}`]: hostile } });
    expect(script).not.toMatch(/[‘’‚‛]/);
    expect(script).not.toContain("calc");
    const decoded = [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
    expect(decoded).toEqual([`K${hostile}`, hostile, `C:\\app\\bin\\${hostile}.exe`, `"${hostile}"`, `"it's ‘quoted’"`]);
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
