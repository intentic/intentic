import type { DeviceCommand, DeviceCommandInput, DeviceCommandResult } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { callTool, forgetPull } from "./device-reports.js";

// This product's own CLI, run from a button on a device the user connected. The set of actions is closed and the
// command line is built here: only a NAME from the contract's enum and a pattern-bounded sandbox id ever reach the
// argv. Not a general remote-execution surface; the machine still refuses via its own switch.

// This side's timeout exceeds the machine's own budget, so an overrun surfaces as its answer, not a cutoff.
const COMMAND_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 25_000;

interface DeviceCommandSpec {
    /** What the action did, in this side's words, for the case where the CLI itself printed nothing. */
    readonly done: string;
    /** The command line, built from the name and at most a validated sandbox id. */
    readonly line: (sandboxId: string | undefined) => string;
    // True when the command refuses to run fleet-wide and needs a sandbox id; only the destructive action sets it.
    readonly scoped?: boolean;
}

// With an id, acts on one paired sandbox; bare, acts on every sandbox the device pairs. Only the reversible verbs offer
// the bare form; sync-unpair is scoped and refused without an id.
const forSandbox = (base: string, sandboxId: string | undefined): string => (sandboxId === undefined ? base : `${base} --sandbox ${sandboxId}`);

export const DEVICE_COMMANDS: Readonly<Record<DeviceCommand, DeviceCommandSpec>> = {
    "mirror-off": {
        done: "Port mirroring is off on that device. File syncing is untouched.",
        line: (sandboxId) => forSandbox("intentic-machine sync mirror off", sandboxId),
    },
    "mirror-on": {
        done: "Port mirroring is back on. Ports return to that device's localhost within a few seconds.",
        line: (sandboxId) => forSandbox("intentic-machine sync mirror on", sandboxId),
    },
    // Pausing sync also pauses the workspace's state backup, so it never writes into a folder mid-pause.
    "sync-pause": {
        done: "File syncing is paused on that device. Its ports keep being mirrored.",
        line: (sandboxId) => forSandbox("intentic-machine sync pause", sandboxId),
    },
    "sync-resume": {
        done: "File syncing has resumed on that device.",
        line: (sandboxId) => forSandbox("intentic-machine sync resume", sandboxId),
    },
    // Uninstall ends both sync sessions and self-revokes enrollment; the sandbox and local folder are untouched.
    "sync-unpair": {
        done: "That device has stopped syncing this sandbox. Its local folder is left exactly as it is.",
        line: (sandboxId) => forSandbox("intentic-machine sync uninstall", sandboxId),
        scoped: true,
    },
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
    const line = spec.line(input.sandboxId);
    try {
        const answer = await callTool(
            services,
            input.id,
            "run_command",
            { command: line, timeoutMs: COMMAND_TIMEOUT_MS },
            AbortSignal.timeout(CALL_TIMEOUT_MS),
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
