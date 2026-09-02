import type { MachineCommand, MachineCommandInput, MachineCommandResult } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { callTool, forgetPull } from "./machine-reports.js";

/* THIS PRODUCT'S OWN CLI, RUN FROM A BUTTON, on a computer the user connected.
 *
 * The gap this closes is small to describe and was the whole of the complaint: the thing the user wants
 * ("stop putting these ports on my localhost") is one command on their own machine, the agent that runs it is
 * already connected, and the only two ways to reach it were to go and find a terminal, or to ask a model to do
 * it — which spends a turn, a round trip and somebody's judgement on a decision that contains none. A button is
 * the right shape for a fixed action, and this is the engine under it.
 *
 * THE SET IS CLOSED AND THE COMMAND LINE IS BUILT HERE. That is the entire security property and the reason
 * this file is a table rather than a parameter. The socket underneath carries `run_command`, so a route that
 * forwarded caller-supplied text would hand every browser session an unlogged shell on somebody's laptop, which
 * is a grant no capability card ever made. What travels from the browser is a NAME from the contract's enum;
 * the only caller-shaped thing that reaches an argv is the sandbox id, and the contract pattern-bounds it to
 * the characters an id can contain before it gets here.
 *
 * WHAT THIS IS NOT: a general remote-execution surface, and it should stay uncomfortable to add to. Every entry
 * is an action a person could reasonably press a button for, on a machine they own, whose effect they can read
 * back on the same page. Anything needing arguments a user has to compose is a terminal's job, or an agent's.
 *
 * THE MACHINE STILL HAS THE LAST WORD. `run_command` needs its "Run commands" switch, and a refusal comes back
 * as the machine's own sentence naming the control to flip, exactly as it does for the sandbox ops next door.
 * This side adds no judgement of its own beyond deciding which named actions exist. */

/* The budget the machine is given, and this side's own ceiling above it.
 *
 * These commands are local work: writing one small JSON file and terminating a handful of Mutagen forwards. The
 * one that can genuinely take a moment is `mirror off`, which asks Mutagen's daemon to list and terminate
 * sessions. The machine's budget sits BELOW ours by about a round trip, so an overrun arrives as the machine's
 * own answer rather than being cut off mid-sentence from here (the same pairing machine-reports.ts uses). */
const COMMAND_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 25_000;

interface MachineCommandSpec {
    /** What the action did, in this side's words, for the case where the CLI itself printed nothing. */
    readonly done: string;
    /** The command line, built from the name and at most a validated sandbox id. */
    readonly line: (sandboxId: string | undefined) => string;
    /* Whether this one REFUSES to run fleet-wide. Bare, the agent's CLI acts on every sandbox that computer
     * pairs, which is a reasonable thing to mean in a terminal and a trap on a route: `sync-unpair` without an id
     * is "unpair every sandbox on this machine and remove sync's whole residue", reachable by omitting a field.
     * The reversible switches keep the bare form (it is the honest "turn it off entirely"); the one that destroys
     * a pairing has to name the pairing. */
    readonly scoped?: boolean;
}

// Bare, the agent's `sync mirror` acts on every sandbox that computer pairs, which is the "turn it off entirely"
// case; with an id it acts on one. The browser sends the id it is looking at, so a button on one sandbox's row
// never reaches across to a colleague's pairing on the same machine.
const forSandbox = (base: string, sandboxId: string | undefined): string => (sandboxId === undefined ? base : `${base} --sandbox ${sandboxId}`);

export const MACHINE_COMMANDS: Readonly<Record<MachineCommand, MachineCommandSpec>> = {
    "mirror-off": {
        done: "Port mirroring is off on that computer. File syncing is untouched.",
        line: (sandboxId) => forSandbox("intentic-machine sync mirror off", sandboxId),
    },
    "mirror-on": {
        done: "Port mirroring is back on. Ports return to that computer's localhost within a few seconds.",
        line: (sandboxId) => forSandbox("intentic-machine sync mirror on", sandboxId),
    },
    /* THE FILE-SYNC HALF, which had a CLI and no button while its twin above had both.
     *
     * "Stop touching my files for an hour" is the same size of ask as "keep these ports off my localhost", and
     * the two live one line apart on the same row: the folder and the ports of one pairing. One of them was a
     * click and the other was a paragraph naming a command to go and type, for no reason except which had been
     * built. Pause is also the honest answer to a conflict somebody is about to resolve by hand, which is the
     * situation this product is otherwise worst at.
     *
     * Both halves of the pair move together on the machine (its `sync pause` pauses the state backup with the
     * workspace session, deliberately: leaving the backup writing into a folder its owner just asked the agent
     * to stop touching would be the wrong reading of "pause"). */
    "sync-pause": {
        done: "File syncing is paused on that computer. Its ports keep being mirrored.",
        line: (sandboxId) => forSandbox("intentic-machine sync pause", sandboxId),
    },
    "sync-resume": {
        done: "File syncing has resumed on that computer.",
        line: (sandboxId) => forSandbox("intentic-machine sync resume", sandboxId),
    },
    /* THE ONE THAT DESTROYS SOMETHING, and the reason it is the machine's `uninstall` rather than a revoke from
     * this side: the agent terminates both Mutagen sessions, drops its local pairing and self-revokes its own
     * enrollment on the way out, so the machine cleans up after itself instead of leaving this side to guess
     * how far it got. A machine that cannot be reached is a different act with a different door (the owner's
     * per-machine enrollment revoke), and the row offers that one instead.
     *
     * Nothing in the sandbox is touched, and neither is anything in the local folder: what ends is the pairing
     * between the two. */
    "sync-unpair": {
        done: "That computer has stopped syncing this sandbox. Its local folder is left exactly as it is.",
        line: (sandboxId) => forSandbox("intentic-machine sync uninstall", sandboxId),
        scoped: true,
    },
};

/* READING THE MACHINE'S ANSWER, which arrives as prose: `run_command` is written for the agent, its only other
 * caller, so it answers with an exit line and the streams under fences (the host agent's describeResult). Pure
 * and exported, because these three lines are what decides whether a button turns green or red.
 *
 * Success is the exit line and nothing else. Not "did it print something", not "was there stderr": a CLI that
 * warns on stderr and exits 0 worked, and one that prints a cheerful sentence and exits 1 did not. */
const STDOUT_FENCE = "--- stdout ---";
const STDERR_FENCE = "--- stderr ---";

export const succeeded = (text: string): boolean => /^Exit code 0 \(success\)/m.test(text);

// One stream out of the fenced answer. Absent (a command that printed nothing on it) is an empty string, which
// every caller here already treats as "say something else instead".
export const streamOf = (text: string, fence: string): string => {
    const start = text.indexOf(fence);
    if (start === -1) {
        return "";
    }
    const rest = text.slice(start + fence.length);
    const end = [STDOUT_FENCE, STDERR_FENCE].map((other) => rest.indexOf(other)).filter((at) => at !== -1);
    return (end.length === 0 ? rest : rest.slice(0, Math.min(...end))).trim();
};

/* What the person who clicked reads. The CLI's OWN sentence wins wherever there is one: it says exactly what
 * changed and for which sandboxes ("Port mirroring OFF for: sandbox-0738…"), which is better than anything this
 * side would write over the top of it, and it is the same sentence they would have got from the terminal.
 *
 * A failure keeps the machine's words for the same reason, stderr first because that is where a CLI puts the
 * reason, falling back to the whole answer when a command died without saying anything a person can read. */
export const outcomeOf = (command: MachineCommand, answer: { text: string; refused: boolean }): MachineCommandResult => {
    const spec = MACHINE_COMMANDS[command];
    if (answer.refused) {
        // The host agent refuses out-of-scope calls as a VALUE naming the switch, so this is the machine
        // explaining itself, not an error to dress up.
        return { ok: false, message: answer.text.trim() === "" ? "That computer refused to run commands." : answer.text.trim(), output: answer.text };
    }
    const out = streamOf(answer.text, STDOUT_FENCE);
    if (succeeded(answer.text)) {
        return { ok: true, message: out === "" ? spec.done : out, output: answer.text };
    }
    const err = streamOf(answer.text, STDERR_FENCE);
    return { ok: false, message: [err, out].find((part) => part !== "") ?? answer.text.trim(), output: answer.text };
};

/* Run one named action on one connected computer.
 *
 * Only an unreachable machine THROWS: a laptop that is asleep has nothing to report, so the caller needs an
 * error rather than a verdict. Everything the machine actually answered — a refusal, a CLI that exited
 * non-zero — comes back as `ok: false` carrying its words, because that is a real answer to show the person who
 * pressed the button. */
export const runMachineCommand = async (services: Services, input: MachineCommandInput): Promise<MachineCommandResult> => {
    const spec = MACHINE_COMMANDS[input.command];
    // A caller that omitted the sandbox on a scoped command is asking for the fleet-wide form of something that
    // has no safe fleet-wide form. Refused here rather than narrowed in the schema: the field is legitimately
    // optional for the switches beside it, and one enum member wanting it is not a second input shape.
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
                    : `"${input.id}" could not be reached: the computer is asleep, offline, or its agent isn't running.`,
        });
    } finally {
        // Whatever happened, the machine may have changed: a command that timed out from here still ran there.
        // The view's next read must describe the machine as it is now, not as the cache remembers it.
        forgetPull(input.id);
    }
};
