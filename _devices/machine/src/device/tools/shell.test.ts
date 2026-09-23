import type { DeviceScopes } from "@intentic/sandbox-contract";
import { ScopeError } from "../policy.js";
import { type CommandResult, describeResult, destructiveClasses, runCommand } from "./shell.js";

// `shell` used to check only WHERE a command would start (cwd, against the roots), never WHAT it would do, so
// an agent could run `rm -rf ~/projects` and the sandbox's command gate never saw it (it hooks Bash and the JS
// backend; this arrives as an MCP call on a different machine). These tests run real, harmless commands, since
// the refusal has to happen before the spawn.

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "off",
    screen: "on",
    control: "off",
    sandboxes: "off",
    destructive: "off",
    roots: "/tmp",
    ...overrides,
});

test("a destructive command is refused when only `shell` is on", async () => {
    await expect(runCommand({ command: "rm -rf /tmp/does-not-exist" }, scopes())).rejects.toThrow(ScopeError);
});

// The refusal has to name the switch, or the user is told only that something was blocked and has nowhere to go.
test("the refusal names the switch and what the command would have done", async () => {
    await expect(runCommand({ command: "rm -rf /tmp/does-not-exist" }, scopes())).rejects.toThrow(/Run destructive commands/);
    await expect(runCommand({ command: "mkfs.ext4 /dev/sda1" }, scopes())).rejects.toThrow(/wipe a disk/);
});

// Read before the cwd is resolved: a destructive command outside the roots used to be refused for the cwd,
// sending the reader to widen "Folders it may touch" instead.
test("a destructive command outside the roots is refused for what it does, not for where it starts", async () => {
    const failure = await runCommand({ command: "rm -rf /etc", cwd: "/etc" }, scopes()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScopeError);
    expect(String(failure)).toContain("Run destructive commands");
    expect(String(failure)).not.toContain("Folders it may touch");
});

test("turning the switch on lets the same command through", async () => {
    const result = await runCommand({ command: "rm -rf /tmp/intentic-shell-test-absent" }, scopes({ destructive: "on" }));
    expect(result.exitCode).toBe(0);
});

// The whole point of one extra switch rather than five: a connected device stays useful with it off.
test("ordinary work is untouched by the switch", async () => {
    const result = await runCommand({ command: "echo hello" }, scopes());
    expect(result.stdout.text.trim()).toBe("hello");
});

// Only the classes that destroy something are gated here; the rest are the sandbox rulebook's to hold, with a
// card and a person to answer it.
test("the other classes are the sandbox's to judge, not this machine's", () => {
    expect(destructiveClasses("cat .env")).toEqual([]);
    expect(destructiveClasses("npm publish")).toEqual([]);
    expect(destructiveClasses("curl https://api.github.com/user")).toEqual([]);
    expect(destructiveClasses("git push --force origin main")).toEqual([]);
});

test("every deletion class is gated, and a root delete is in two of them", () => {
    expect(destructiveClasses("rm -rf build")).toEqual(["files.destructive"]);
    expect(destructiveClasses("rm -rf ~")).toEqual(["files.destructive", "system.destructive"]);
});

// A container volume is its own class as of the locus split, and stays gated here while the sandbox hands it
// to the judge: in this container the reachable volumes are the nested engine's, but on somebody's own computer
// a named volume IS the database.
test("a container volume still needs the destructive switch on a real machine", () => {
    expect(destructiveClasses("docker volume rm app_data")).toEqual(["container.state"]);
    expect(destructiveClasses("docker compose down -v")).toEqual(["container.state"]);
});

// Read at the `device` locus, the other half of the split: `~` and `C:` are roots on somebody's computer and
// scratch in a container.
test("a device's roots are the device's, not the sandbox's", () => {
    for (const command of ["rm -rf /usr", "rm -rf /etc", "rm -rf C:\\", "rm -rf /Users"]) {
        expect(destructiveClasses(command), command).toContain("system.destructive");
    }
});

// A command that only mentions a delete does not need the switch: refusing there taught people to leave
// `destructive` on permanently, the opposite of what it is for.
test("a delete that is printed, searched for or commented is not gated", () => {
    for (const command of [`echo "rm -rf ~" >> notes.md`, `grep -n "rm -rf" scripts/deploy.sh`, `ls # not rm -rf ~`]) {
        expect(destructiveClasses(command), command).toEqual([]);
    }
});

// `shell` still comes first: a machine that may not run commands at all is not asked what kind of command it is.
test("the shell switch is still the outer question", async () => {
    await expect(runCommand({ command: "echo hello" }, scopes({ shell: "off" }))).rejects.toThrow(/Run commands/);
});

// The crossing is a way of running, not a way around the switches: the classifier reads the script before any argv
// is built, and a shell that may not run commands here may not run them there either.
test("a crossed command is still judged for what it does, and still needs the shell switch", async () => {
    await expect(runCommand({ command: "rm -rf /tmp/does-not-exist", in: "wsl:Arch" }, scopes())).rejects.toThrow(/Run destructive commands/);
    await expect(runCommand({ command: "echo hello", in: "windows" }, scopes({ shell: "off" }))).rejects.toThrow(/Run commands/);
});

const ran = (overrides: Partial<Pick<CommandResult, "exitCode" | "timedOut" | "lingering">> = {}): CommandResult => ({
    exitCode: 0,
    stdout: { text: "", dropped: 0 },
    stderr: { text: "", dropped: 0 },
    timedOut: false,
    lingering: false,
    ...overrides,
});

// The sandbox reads this answer back (hosts/device-commands.ts): a line starting "Exit code 0 (success)" is success, and
// the streams sit under their fences. Whatever else the summary says has to leave both where they are.
test("a cut answer says how much was left out, and still opens with the exit code over fenced streams", () => {
    const text = describeResult(
        { ...ran(), stdout: { text: "start\n… [4200 characters cut] …\nend", dropped: 4200 }, stderr: { text: "warning", dropped: 0 } },
        60_000,
    );
    expect(text).toBe(
        "Exit code 0 (success). Too long to return whole: 4200 characters from the middle of stdout are left out, where it says so." +
            "\n--- stdout ---\nstart\n… [4200 characters cut] …\nend\n--- stderr ---\nwarning",
    );
});

test("a command that left something running says its later output is not collected, and how to keep it", () => {
    expect(describeResult(ran({ lingering: true }), 60_000)).toBe(
        "Exit code 0 (success). It left something running in the background, and what that prints from now on is not collected: start background work with its output redirected to a file (`> out.log 2>&1`), or it may fail on its next write to a pipe nobody reads.",
    );
});

test("a timed-out command is reported as stopped together with what it started", () => {
    expect(describeResult(ran({ exitCode: null, timedOut: true }), 90_000)).toMatch(/^The command was stopped after 90s, and everything it started with it\./);
});
