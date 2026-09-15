import { installScriptUrl } from "@intentic/constants";
import type { DeviceCommand, DeviceCommandInput, DeviceCommandResult } from "@intentic/sandbox-contract";
import { DEV_REBUILD_EXIT_MARK, DEV_REBUILD_QUIET_MARK, devRebuildLogPath, doorHoldsPath } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { callTool, forgetPull } from "./device-reports.js";
import { ownSlug } from "./self-host.js";

// This product's own CLI, run from a button on a device the user connected. The set of actions is closed and the
// command line is built here: what reaches the argv is a NAME from the contract's enum, a pattern-bounded sandbox id
// or folder, and values only the daemon holds (the dev checkout this container records, a pairing minted for the one
// call). Not a general remote-execution surface; the machine still refuses via its own switch.

// This side's timeout exceeds the machine's own budget, so an overrun surfaces as its answer, not a cutoff.
const COMMAND_TIMEOUT_MS = 20_000;
// A build (dev-reload) or an install that fetches Mutagen and cloudflared (sync-install) is minutes, not seconds; the
// machine's own ceiling is ten minutes, and the hub's connection ceiling is above that.
const LONG_COMMAND_TIMEOUT_MS = 8 * 60_000;
// Slack over the machine's own budget, whichever budget the command chose.
const CALL_SLACK_MS = 5_000;

// What the daemon knows when it fills in a command line. Only `sandboxId` and `localDir` come from the caller, both
// pattern-bounded by the contract; the rest is this sandbox's own knowledge of itself and of the machine it is talking
// to, which is the whole reason these lines are built here rather than sent by a browser.
export interface DeviceCommandFacts {
    readonly sandboxId: string | undefined;
    readonly ownSlug: string | undefined;
    readonly devRoot: string | undefined;
    readonly publicUrl: string;
    readonly platform: string | undefined;
    readonly mode: "sync" | "mirror" | undefined;
    readonly localDir: string | undefined;
    /** Minted for this one call, and only for a command whose spec asks for one. */
    readonly pairToken: string | undefined;
}

interface DeviceCommandSpec {
    /** What the action did, in this side's words, for the case where the CLI itself printed nothing. */
    readonly done: string;
    // The command line, or undefined when this sandbox cannot form one; `needs` then says what is missing, since
    // "no line" is a fact about where this sandbox runs rather than a failure on the device.
    readonly line: (facts: DeviceCommandFacts) => string | undefined;
    /** Why a command could not be formed here, in the refusal's own words. */
    readonly needs?: string;
    // True when the command refuses to run fleet-wide and needs a sandbox id; only the destructive action sets it.
    readonly scoped?: boolean;
    /** Above the 20s default for a command that downloads or builds. */
    readonly timeoutMs?: number;
    /** Mints a single-use desktop-sync pairing for this call; only the enrolling command asks. */
    readonly mints?: boolean;
    // The path on the device this line is written for, when it has one. Only the environment holding that path can
    // run the line, and a PC answers for its containers through every door on it, so the door that reports this
    // sandbox is not yet the door that can `cd` into its checkout.
    readonly path?: (facts: DeviceCommandFacts) => string | undefined;
}

// With an id, acts on one paired sandbox; bare, acts on every sandbox the device pairs. Only the reversible verbs offer
// the bare form; sync-unpair is scoped and refused without an id.
const forSandbox = (base: string, sandboxId: string | undefined): string => (sandboxId === undefined ? base : `${base} --sandbox ${sandboxId}`);

// A leading `~` is expanded by the shell only outside quotes, so the daemon writes `$HOME` itself: the contract's own
// schema refuses a `$` from the caller, which makes this the only one in the line.
const shellDir = (dir: string): string => `"${dir.replace(/^~(?=[\\/]|$)/, "$HOME")}"`;

// BOTH DEV COMMANDS NEED pnpm, AND THE AGENT'S SHELL USUALLY HASN'T GOT IT. Its installer writes PNPM_HOME into the
// INTERACTIVE rc (.zshrc/.bashrc); the agent runs a login shell, which never reads those, so a line that just says
// `pnpm` dies with "command not found" on a machine where the owner's own terminal runs it fine. Prepended rather than
// substituted: a PATH that already has pnpm keeps winning, and a machine that keeps it elsewhere is unaffected.
const WITH_PNPM = 'export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"; export PATH="$PNPM_HOME:$PNPM_HOME/bin:$PATH";';

// The install one-liner for this sandbox, in the dialect of the device's own shell — the same script, environment and
// single-use token the card's copyable command carries, built from the same table (@intentic/constants).
const installLine = (facts: DeviceCommandFacts): string | undefined => {
    if (facts.pairToken === undefined || facts.publicUrl === "") {
        return undefined;
    }
    // Mirror enrollments carry no folder at all: they forward ports and touch no files.
    const dir = facts.mode === "mirror" ? undefined : facts.localDir;
    if (facts.platform === "windows") {
        const env = `$env:SANDBOX_URL='${facts.publicUrl}'; $env:PAIR_TOKEN='${facts.pairToken}';${
            dir === undefined ? "" : ` $env:SYNC_DIR=${shellDir(dir)};`
        }`;
        return `${env} irm ${installScriptUrl("desktopPs1")} | iex`;
    }
    const env = `env SANDBOX_URL='${facts.publicUrl}' PAIR_TOKEN='${facts.pairToken}'${dir === undefined ? "" : ` SYNC_DIR=${shellDir(dir)}`}`;
    return `curl -fsSL ${installScriptUrl("desktopSh")} | ${env} sh`;
};

export const DEVICE_COMMANDS: Readonly<Record<DeviceCommand, DeviceCommandSpec>> = {
    "mirror-off": {
        done: "Port mirroring is off on that device. File syncing is untouched.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync mirror off", sandboxId),
    },
    "mirror-on": {
        done: "Port mirroring is back on. Ports return to that device's localhost within a few seconds.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync mirror on", sandboxId),
    },
    // Pausing sync also pauses the workspace's state backup, so it never writes into a folder mid-pause.
    "sync-pause": {
        done: "File syncing is paused on that device. Its ports keep being mirrored.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync pause", sandboxId),
    },
    "sync-resume": {
        done: "File syncing has resumed on that device.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync resume", sandboxId),
    },
    // Uninstall ends both sync sessions and self-revokes enrollment; the sandbox and local folder are untouched.
    "sync-unpair": {
        done: "That device has stopped syncing this sandbox. Its local folder is left exactly as it is.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync uninstall", sandboxId),
        scoped: true,
    },
    // Enrolls the device we are already talking to, instead of printing its one-liner for someone to paste there. The
    // token is minted for this call alone and never leaves the daemon.
    "sync-install": {
        done: "That device is enrolled. Its folder and this sandbox's ports appear on its row within a few seconds.",
        line: installLine,
        needs: "this sandbox has no public address for a device to dial yet",
        timeoutMs: LONG_COMMAND_TIMEOUT_MS,
        mints: true,
    },
    /* Dev rebuilds run detached and record an exit mark for later polling. */
    "dev-rebuild": {
        done: "The rebuild is running on that device. Your sandbox restarts on the new image when it is built, and this page reconnects on its own.",
        line: (facts) =>
            facts.devRoot === undefined || facts.ownSlug === undefined
                ? undefined
                : `${WITH_PNPM} mkdir -p "$HOME/.intentic/logs" && cd ${shellDir(facts.devRoot)} && nohup sh -c 'pnpm rebuild:sandbox ${facts.ownSlug}; printf "\\n${DEV_REBUILD_EXIT_MARK} %s\\n" "$?"' > ${shellDir(devRebuildLogPath(facts.ownSlug))} 2>&1 &`,
        needs: "only a dev sandbox launched by dev-sandbox.sh knows which checkout to rebuild from",
        path: (facts) => facts.devRoot,
    },
    /* The read side of the command above, polled by whoever is watching. Bounded twice (bytes, then lines) because it
     * is polled every few seconds and a docker build's log is not small; the header is the log's own mtime, which is
     * what separates a build sitting inside a slow layer from one whose machine went to sleep. Needs only the slug —
     * reading a log takes the log's name, not the checkout it came from — so a sandbox can still be told how its last
     * rebuild ended after the checkout it was built from has moved. */
    "dev-rebuild-log": {
        done: "That device has no rebuild log for this sandbox.",
        line: (facts) =>
            facts.ownSlug === undefined
                ? undefined
                : `log=${shellDir(devRebuildLogPath(facts.ownSlug))}; if [ -f "$log" ]; then at=$(stat -c %Y "$log" 2>/dev/null || stat -f %m "$log" 2>/dev/null || echo); if [ -n "$at" ]; then echo "${DEV_REBUILD_QUIET_MARK} $(( $(date +%s) - at ))"; else echo "${DEV_REBUILD_QUIET_MARK} ?"; fi; tail -c 12000 "$log" | tail -n 80; else echo "${DEV_REBUILD_QUIET_MARK} -"; fi`,
        needs: "this sandbox does not know its own name, so it cannot name the log to read",
        // The log, not the checkout: this is the one dev command that needs no checkout, and the log lives in the home
        // of whichever environment ran the build.
        path: (facts) => (facts.ownSlug === undefined ? undefined : devRebuildLogPath(facts.ownSlug)),
    },
    // The dev inner loop, run where the checkout is: compile the daemon and restart this very container. The slug is
    // this sandbox's own, never the caller's, and the answer usually never arrives — the daemon carrying it is the one
    // being restarted, which the card treats as the expected ending.
    "dev-reload": {
        done: "Reloaded: the daemon is running the code in that checkout.",
        line: (facts) =>
            facts.devRoot === undefined || facts.ownSlug === undefined
                ? undefined
                : `${WITH_PNPM} sh ${shellDir(facts.devRoot)}/_sandbox/sandbox/scripts/dev-reload.sh ${facts.ownSlug}`,
        needs: "only a dev sandbox launched by dev-sandbox.sh knows which checkout to reload from",
        timeoutMs: LONG_COMMAND_TIMEOUT_MS,
        path: (facts) => facts.devRoot,
    },
};

// Everything a line is built from, gathered once per call. A pairing is minted only for the command that asks for one,
// so no other action mints a credential as a side effect of being run.
const commandFacts = async (services: Services, input: DeviceCommandInput): Promise<DeviceCommandFacts> => {
    const spec = DEVICE_COMMANDS[input.command];
    const card = (await services.capabilities.list()).find((capability) => capability.id === input.id);
    return {
        sandboxId: input.sandboxId,
        ownSlug: ownSlug(services),
        devRoot: services.config.sandbox.devRoot,
        publicUrl: services.config.sandbox.publicUrl,
        platform: card?.kind === "host" ? card.config.platform : undefined,
        mode: input.mode,
        localDir: input.localDir,
        pairToken: spec.mints === true ? services.syncPairings.mint(input.mode ?? "sync").token : undefined,
    };
};

// Why this door cannot run this command, though another door of the same computer could. Refused here rather than
// left to the device: a unix line handed to a PC's Windows side comes back as a PowerShell parse error, which reads
// as a broken command instead of the wrong door. Exported for the message's own test.
export const wrongDoor = (spec: DeviceCommandSpec, facts: DeviceCommandFacts, input: DeviceCommandInput): string | undefined => {
    const path = spec.path?.(facts);
    return path === undefined || doorHoldsPath(facts.platform, path)
        ? undefined
        : `"${input.command}" runs ${path}, which is not a path in the environment "${input.id}" opens onto. One computer answers for its ` +
              `containers through every door on it — send this to the door whose own shell holds that path.`;
};

// run_command answers with an exit line plus fenced stdout/stderr; success reads the exit line only, never what was
// printed.
const STDOUT_FENCE = "--- stdout ---";
const STDERR_FENCE = "--- stderr ---";

export const succeeded = (text: string): boolean => /^Exit code 0 \(success\)/m.test(text);

// One stream out of the fenced answer; absent is an empty string, which every caller treats as "say something else
// instead".
export const streamOf = (text: string, fence: string): string => {
    const start = text.indexOf(fence);
    if (start === -1) {
        return "";
    }
    const rest = text.slice(start + fence.length);
    const end = [STDOUT_FENCE, STDERR_FENCE].map((other) => rest.indexOf(other)).filter((at) => at !== -1);
    return (end.length === 0 ? rest : rest.slice(0, Math.min(...end))).trim();
};

// The CLI's own sentence wins when there is one, the same words the terminal would show. On failure, stderr comes
// first, falling back to the whole answer if nothing readable came back.
export const outcomeOf = (command: DeviceCommand, answer: { text: string; refused: boolean }): DeviceCommandResult => {
    const spec = DEVICE_COMMANDS[command];
    if (answer.refused) {
        // The host agent's refusal is a value naming the switch, not an error to dress up.
        return { ok: false, message: answer.text.trim() === "" ? "That device refused to run commands." : answer.text.trim(), output: answer.text };
    }
    const out = streamOf(answer.text, STDOUT_FENCE);
    if (succeeded(answer.text)) {
        return { ok: true, message: out === "" ? spec.done : out, output: answer.text };
    }
    const err = streamOf(answer.text, STDERR_FENCE);
    return { ok: false, message: [err, out].find((part) => part !== "") ?? answer.text.trim(), output: answer.text };
};

// Only an unreachable machine throws. Everything the machine actually answered, a refusal or a nonzero exit, comes back
// as ok: false carrying its words.
export const runDeviceCommand = async (services: Services, input: DeviceCommandInput): Promise<DeviceCommandResult> => {
    const spec = DEVICE_COMMANDS[input.command];
    // Refused here, not in the schema, since the field is optional for the other switches and only this one needs it.
    if (spec.scoped === true && input.sandboxId === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: `"${input.command}" has to name the sandbox it acts on.` });
    }
    const facts = await commandFacts(services, input);
    const refusal = wrongDoor(spec, facts, input);
    if (refusal !== undefined) {
        throw new ORPCError("CONFLICT", { message: refusal });
    }
    const line = spec.line(facts);
    // A line this sandbox cannot form is a fact about where it runs, not something the device could answer.
    if (line === undefined) {
        throw new ORPCError("CONFLICT", { message: `"${input.command}" isn't available here: ${spec.needs ?? "this sandbox cannot form it"}.` });
    }
    const timeoutMs = spec.timeoutMs ?? COMMAND_TIMEOUT_MS;
    try {
        const answer = await callTool(
            services,
            input.id,
            "run_command",
            { command: line, timeoutMs },
            AbortSignal.timeout(timeoutMs + CALL_SLACK_MS),
        );
        return outcomeOf(input.command, answer);
    } catch (error) {
        throw new ORPCError("CONFLICT", {
            message:
                error instanceof Error
                    ? error.message
                    : `"${input.id}" could not be reached: the device is asleep, offline, or its agent isn't running.`,
        });
    } finally {
        // Forget timed-out pulls so the next read cannot use stale state.
        forgetPull(input.id);
    }
};
