import { installScriptUrl } from "@intentic/constants";
import type { DeviceCommand, DeviceCommandInput, DeviceCommandResult } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { callTool, forgetPull } from "./device-reports.js";
import { devRoot, ownSlug } from "./self-host.js";

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
}

// With an id, acts on one paired sandbox; bare, acts on every sandbox the device pairs. Only the reversible verbs offer
// the bare form; sync-unpair is scoped and refused without an id.
const forSandbox = (base: string, sandboxId: string | undefined): string => (sandboxId === undefined ? base : `${base} --sandbox ${sandboxId}`);

// A leading `~` is expanded by the shell only outside quotes, so the daemon writes `$HOME` itself: the contract's own
// schema refuses a `$` from the caller, which makes this the only one in the line.
const shellDir = (dir: string): string => `"${dir.replace(/^~(?=[\\/]|$)/, "$HOME")}"`;

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
    // The dev inner loop, run where the checkout is: compile the daemon and restart this very container. The slug is
    // this sandbox's own, never the caller's, and the answer usually never arrives — the daemon carrying it is the one
    // being restarted, which the card treats as the expected ending.
    "dev-reload": {
        done: "Reloaded: the daemon is running the code in that checkout.",
        line: (facts) =>
            facts.devRoot === undefined || facts.ownSlug === undefined
                ? undefined
                : `sh ${shellDir(facts.devRoot)}/_sandbox/sandbox/scripts/dev-reload.sh ${facts.ownSlug}`,
        needs: "only a dev sandbox launched by dev-sandbox.sh knows which checkout to reload from",
        timeoutMs: LONG_COMMAND_TIMEOUT_MS,
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
        devRoot: devRoot(services),
        publicUrl: services.config.sandbox.publicUrl,
        platform: card?.kind === "host" ? card.config.platform : undefined,
        mode: input.mode,
        localDir: input.localDir,
        pairToken: spec.mints === true ? services.syncPairings.mint(input.mode ?? "sync").token : undefined,
    };
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
    const line = spec.line(await commandFacts(services, input));
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
        // Clears the cache: a command that timed out here may still have completed there, so the next read must reflect
        // it.
        forgetPull(input.id);
    }
};
