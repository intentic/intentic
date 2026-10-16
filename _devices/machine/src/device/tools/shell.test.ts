import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { ScopeError } from "../policy.js";
import {
    AGENT_COMMAND_ENV,
    assertNoSandboxPower,
    type CommandResult,
    describeResult,
    destructiveClasses,
    markedAsAgentCommand,
    runCommand,
    sandboxPowerIn,
} from "./shell.js";

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
    destructive: "off", programs: "off",
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
    const result = await runCommand({ command: "rm -rf /tmp/intentic-shell-test-absent" }, scopes({ destructive: "on", programs: "off" }));
    expect(result.exitCode).toBe(0);
});

// The sandbox tools refuse without "Manage sandboxes on this device"; `ic` and `docker` through the shell are the same
// tools by another door, and are refused before the spawn like a delete is.
test("a command that manages a sandbox is refused while 'Manage sandboxes on this device' is off, and runs when it is on", async () => {
    for (const command of ["ic sandbox restart work", "ic sandbox update", "docker stop intentic-sandbox-work"]) {
        const failure = await runCommand({ command }, scopes()).catch((error: unknown) => error);
        expect(failure, command).toBeInstanceOf(ScopeError);
        expect(String(failure), command).toContain("Manage sandboxes on this device");
    }
    // Unquoted, an echo is read as the command it spells; switched on, it reaches the shell and prints it.
    const text = "echo ic sandbox restart work";
    await expect(runCommand({ command: text }, scopes())).rejects.toThrow(ScopeError);
    const result = await runCommand({ command: text }, scopes({ sandboxes: "on" }));
    expect(result.stdout.text.trim()).toBe("ic sandbox restart work");
    // A mention that runs nothing is not a command.
    expect((await runCommand({ command: "true # ic sandbox restart work" }, scopes())).exitCode).toBe(0);
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

// The sandbox tools (manage_sandbox, swap_sandbox, reshape_sandbox, remove_sandbox) each refuse without "Manage
// sandboxes on this device"; a shell command that does what they do answers to the same switch, for any sandbox on the
// machine, since this end cannot know which one the caller runs in.

const withSandboxes = (sandboxes: DeviceScopes["sandboxes"]): DeviceScopes => ({
    shell: "on",
    write: "off",
    screen: "on",
    control: "off",
    sandboxes,
    destructive: "off",
    programs: "off",
});

const REFUSALS = [
    "ic sandbox restart work",
    "ic sandbox stop other",
    "ic sandbox rm work -y",
    "ic sandbox rebuild work 3f2a",
    "ic sandbox update",
    "ic sandbox rollback work --to 1.315.0",
    "ic sandbox start work",
    "ic sandbox prepare work --auto",
    "ic sandbox reshape work --memory 12g",
    "& 'C:\\Users\\radar\\.intentic\\bin\\ic.exe' sandbox restart work",
    "docker stop intentic-sandbox-work",
    "docker restart intentic-sandbox-work",
    "docker rm -f intentic-sandbox-other",
    "docker kill intentic-sandbox-tunnel-abc",
    "cd /tmp && ic sandbox restart work",
];

test("each way of managing a sandbox is refused while the switch is off, naming the switch", () => {
    for (const command of REFUSALS) {
        expect(() => assertNoSandboxPower(command, withSandboxes("off")), command).toThrow(ScopeError);
        expect(() => assertNoSandboxPower(command, withSandboxes("off")), command).toThrow(/"Manage sandboxes on this device" is switched off/);
    }
});

test("the same commands run once the switch is on", () => {
    for (const command of REFUSALS) {
        expect(() => assertNoSandboxPower(command, withSandboxes("on")), command).not.toThrow();
    }
});

test("the refusal says what was asked for in ic's own verbs, and how it arrived when it was typed", () => {
    expect(() => assertNoSandboxPower("ic sandbox restart work && ic sandbox stop other", withSandboxes("off"))).toThrow(
        /^Refused: this command would manage a sandbox on this device \(restart, stop\), and/,
    );
    expect(() => assertNoSandboxPower("ic sandbox restart work\n", withSandboxes("off"), "typed")).toThrow(/^Refused: typed into a terminal, this would manage a sandbox/);
});

// On Intentic OS the box's own OS is the ground every sandbox stands on: updating, rolling back or rebooting it through
// the shell answers to the same switch as the os_* tools.
test("an OS update, rollback, channel switch or reboot through the shell is the switch's too, said as the OS's", () => {
    for (const command of ["ic os update", "ic os update --apply", "ic os rollback --apply", "ic os reboot", "ic os channel beta", "sudo bootc upgrade --apply", "sudo bootc switch ghcr.io/intentic/os:beta"]) {
        expect(() => assertNoSandboxPower(command, withSandboxes("off")), command).toThrow(ScopeError);
        expect(() => assertNoSandboxPower(command, withSandboxes("on")), command).not.toThrow();
    }
    expect(() => assertNoSandboxPower("ic os reboot", withSandboxes("off"))).toThrow(
        /^Refused: this command would manage this device's OS, and with it every sandbox on it, \(os-reboot\), and "Manage sandboxes on this device" is switched off/,
    );
    for (const command of ["ic os status --json", "ic os update --check --json", "bootc status", "bootc upgrade --check"]) {
        expect(() => assertNoSandboxPower(command, withSandboxes("off")), command).not.toThrow();
    }
});

test("what only reads, and docker aimed at anything else, is untouched with the switch off", () => {
    for (const command of [
        "ic sandbox list --json",
        "ic sandbox logs work --tail 50",
        "ic sandbox doctor work",
        "docker ps",
        "docker restart postgres",
        "docker stop my-app",
        // Worked out as it runs: this end cannot know what it will be, and does not guess.
        "docker stop $(docker ps -q)",
        "echo 'ic sandbox restart work'",
        "# ic sandbox restart work",
        "git commit -m 'document docker stop intentic-sandbox-work'",
    ]) {
        expect(() => assertNoSandboxPower(command, withSandboxes("off")), command).not.toThrow();
    }
});

test("names the commands a shell would run, however many", () => {
    expect(sandboxPowerIn("ic sandbox restart work; docker stop intentic-sandbox-work").map((hit) => [hit.via, hit.op])).toEqual([
        ["ic", "restart"],
        ["docker", "stop"],
    ]);
});

test("the agent's commands are marked for the keyring's record, over whatever the environment held", () => {
    expect(markedAsAgentCommand({ PATH: "/bin", [AGENT_COMMAND_ENV]: "0" })).toEqual({ PATH: "/bin", INTENTIC_AGENT_COMMAND: "1" });
});
