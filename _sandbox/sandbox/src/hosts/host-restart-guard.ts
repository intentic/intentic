import {
    mayReachSandbox,
    type OwnSandbox,
    ProgramArgumentsSchema,
    type ProgramReading,
    SANDBOX_POWER_DOING,
    sandboxPowerCommands,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import type { Services } from "../composition.js";
import { raiseRequest } from "../guard/card-offers.js";
import type { LiveRun } from "../conversations/actor/conversation-holdings.js";
import { type HeldAnswer, createHeldAsks } from "../guard/held-asks.js";
import { wakeWords } from "../guard/held-cards.js";
import { opt } from "../opt.js";
import { excerptProgram } from "../safety/safety-log.js";
import { conversationUnattended } from "../guard/turn-taint.js";
import { deviceScopesOf, type HostGateRefusal } from "./host-command-guard.js";
import type { HostGuardDeps } from "./host-guard-deps.js";

// AN AGENT RESTARTING THE SANDBOX EVERY OTHER AGENT RUNS IN. swap_sandbox, manage_sandbox and reshape_sandbox reach the
// device's `ic` for a sandbox by its slug, and on this sandbox's own slug each ends by replacing or stopping the
// container every turn here runs in: an orchestrator's rebuild once cut the whole fleet mid-turn, and nobody had been
// asked. The device's "Manage sandboxes" switch says whether an agent may do this at all; this asks the owner whether
// now, on a card naming what it would stop, whenever anything else is in flight. What is in flight is the sandbox's one
// answer to that (HostGuardDeps.working: turns, lands, running subagents and workflow steps), with the caller's own
// turn left out: an agent restarting the ground under itself has chosen to. The same ask guards the same restart spelled
// as a shell command (`ic sandbox restart <slug>`, `docker stop <container>`) in run_command and the other doors that
// carry a program (restartInProgram). Matched by slug alone, so the same slug on another of the owner's devices is asked
// about too, which is the safe way to be wrong.

// How long one call waits here before answering: under the minute an agent's MCP client gives a call before reporting
// a timeout of its own. The card stays up until it is answered, and the same call again collects its answer
// (guard/held-asks.ts).
const CALL_BUDGET_MS = 45_000;

// The one MCP message this gate reads: a tools/call naming a device tool, and of its arguments only the fields that say
// which sandbox and which op. The rest is the machine's to validate; a notification or anything else does not parse, and
// is forwarded as the command gate forwards it.
export const DeviceToolCallSchema = z.object({
    id: z.union([z.string(), z.number()]),
    method: z.literal("tools/call"),
    params: z.object({
        name: z.string(),
        arguments: ProgramArgumentsSchema.extend({ slug: z.string().optional(), op: z.string().optional(), when: z.string().optional() }).optional(),
    }),
});
export type DeviceToolCall = z.infer<typeof DeviceToolCallSchema>;
type ToolArguments = NonNullable<DeviceToolCall["params"]["arguments"]>;

/** A call that would restart or stop this sandbox: the device's tool, its op, and the owner's own word for it. */
export interface RestartCall {
    readonly tool: string;
    readonly op: string;
    readonly doing: string;
    // The command line, for a restart spelled as a shell command: the card shows it, and its answer is kept for it alone.
    readonly commandLine?: string;
}

// Which ops of which tools stop the container, in the words the owner's own buttons use. `prepare` builds beside it,
// `start` wakes one already down, and resources saved for the next restart restart nothing: none of them stops a turn.
const restartOf = (tool: string, args: ToolArguments): Omit<RestartCall, "tool"> | undefined => {
    const { op } = args;
    if (tool === "swap_sandbox" && (op === "update" || op === "rebuild" || op === "rollback")) {
        return { op, doing: SANDBOX_POWER_DOING[op] };
    }
    if (tool === "manage_sandbox" && (op === "restart" || op === "stop")) {
        return { op, doing: SANDBOX_POWER_DOING[op] };
    }
    if (tool === "reshape_sandbox" && args.when === "now") {
        return { op: "now", doing: SANDBOX_POWER_DOING.resize };
    }
    // Removing it stops the container as surely as stopping it does, and takes it off the listing besides.
    if (tool === "remove_sandbox") {
        return { op: "remove", doing: SANDBOX_POWER_DOING.remove };
    }
    return undefined;
};

/** The restart a device tool call would make of the sandbox named `ownSlug`; undefined for anything else. */
export const restartInCall = (call: DeviceToolCall, ownSlug: string | undefined): RestartCall | undefined => {
    const args = call.params.arguments ?? {};
    const restart = restartOf(call.params.name, args);
    return restart === undefined || ownSlug === undefined || args.slug !== ownSlug ? undefined : { tool: call.params.name, ...restart };
};

/**
 * The restart a command carried by a device tool would make of `own` (`ic sandbox restart work`, `docker stop
 * <its container>`); undefined for anything else. Read generously: a command that names no sandbox, or one worked out
 * as it runs, may be this one, and asking the owner once costs less than cutting the fleet unasked. A phone's shell is
 * another computer's, and a start or a download ends nothing.
 */
export const restartInProgram = (reading: ProgramReading, own: OwnSandbox | undefined): RestartCall | undefined => {
    if (own === undefined || reading.kind === "phone-command") {
        return undefined;
    }
    // Not only where a shell would run it: a heredoc piped into `sh` is inert text to the reader and a command to the shell.
    const hit = sandboxPowerCommands(reading.commandLine).find((found) => found.stops && mayReachSandbox(found, own));
    return hit === undefined ? undefined : { tool: reading.tool, op: hit.op, doing: SANDBOX_POWER_DOING[hit.op], commandLine: reading.commandLine };
};

const refusal = (text: string): HostGateRefusal => ({ refusal: text });

// Cards still open (or answered and not yet collected) by the call that raised them (guard/held-asks.ts).
const heldAsks = createHeldAsks<HostGateRefusal | undefined>();

const stillWaiting = (machine: string, call: RestartCall): string =>
    `Still waiting for the owner: a card asks them to approve ${call.tool} ${call.op} on "${machine}", and nothing has run yet. ` +
    `Their answer is kept for this exact call: make it again with the same arguments to wait for it. Do not restart the sandbox another way.`;

// What the agent reads when the device's own "Manage sandboxes on this device" switch is off: the device refuses every one
// of these however the owner answers, so no card is raised for a yes that cannot work.
const switchedOff = (machine: string, call: RestartCall): string =>
    `Refused: this would ${call.doing.toLowerCase()} the sandbox you run in on "${machine}", and its "Manage sandboxes on this device" switch is off, ` +
    `so the device would refuse it even if the owner approved. Ask the owner to turn on "Manage sandboxes on this device" in ${machine}'s capability card. ` +
    `Do not look for another spelling that gets past it.`;

interface RestartAsk {
    readonly conversationId: string;
    readonly machine: string;
    readonly call: RestartCall;
    // What is in flight here besides the caller, by the name the board or the run shows it under.
    readonly stopping: readonly string[];
    // Whether a turn a restart killed runs again by itself (the owner's autoResumeOnRestart), which the card says.
    readonly resumes: boolean;
}

// Who the card says it stops, and what becomes of them, in the count's own grammar.
const stoppingSaid = (ask: RestartAsk): string => {
    const one = ask.stopping.length === 1;
    const who = one ? "the agent" : `the ${ask.stopping.length} agents`;
    const after = ask.resumes
        ? one
            ? "It picks up again by itself once the sandbox is back."
            : "They pick up again by themselves once the sandbox is back."
        : one
          ? "Its work is kept, and it waits to be continued once the sandbox is back."
          : "Their work is kept, and each waits to be continued once the sandbox is back.";
    return `It restarts the sandbox on ${ask.machine}, which stops ${who} working in it now: ${ask.stopping.join(", ")}. ${after}`;
};

// `ended` settles the card at once: the turn's end (a yes given after it would restart the sandbox for nobody) or a stop
// while the turn's close held for it.
const askOwner = async (guards: HostGuardDeps, run: LiveRun, ended: AbortSignal, ask: RestartAsk): Promise<HeldAnswer<HostGateRefusal | undefined>> => {
    const { doing } = ask.call;
    const answered = await raiseRequest(
        guards.cards,
        { conversationId: ask.conversationId, push: (event) => run.push(event) },
        {
            kind: "permission",
            onAbort: { kind: "permission", requestId: "", decision: "deny" },
            raised: (requestId) => ({
                kind: "permission",
                requestId,
                toolName: `${ask.machine}__${ask.call.tool}`,
                title: `${doing} this sandbox now?`,
                displayName: `${doing} this sandbox`,
                description: stoppingSaid(ask),
                // A restart spelled as a command shows the command, since the tool's name alone does not say which.
                ...opt("program", ask.call.commandLine === undefined ? undefined : { text: excerptProgram(ask.call.commandLine), language: "bash" as const, truncated: false, spans: [] }),
            }),
            approves: (answer) => answer.decision !== "deny",
            // Other conversations' turns stop with it, so this conversation's own standing yes is not enough.
            alwaysAsks: true,
            signal: ended,
        },
    );
    if (answered.decision === "unanswered") {
        return {
            answer: refusal(`The turn ended before anyone answered, so the sandbox was not restarted. Do not retry it unasked.`),
            outcome: { decision: "unanswered" },
        };
    }
    if (answered.decision === "declined") {
        const feedback = answered.reply.feedback?.trim();
        return {
            answer: refusal(feedback || `The owner declined: not now. Do not restart the sandbox another way; say what is left undone until it can be.`),
            outcome: { decision: "declined", ...opt("feedback", feedback === "" ? undefined : feedback) },
        };
    }
    return { answer: undefined, outcome: { decision: "approved" } };
};

/**
 * Holds an agent's restart of this sandbox for the owner while anything else is in flight in it; undefined forwards the
 * call to the device, whose own switch still decides.
 */
export const judgeHostRestart = async (
    services: Pick<Services, "capabilities" | "hosts" | "sandboxSettings">,
    guards: HostGuardDeps,
    input: { readonly machine: string; readonly call: RestartCall; readonly conversationId: string | undefined },
    budgetMs: number = CALL_BUDGET_MS,
): Promise<HostGateRefusal | undefined> => {
    const at = Date.now();
    const { conversationId, machine, call } = input;
    const asked = (id: string) => ({
        conversationId: id,
        key: `${machine}\u0000${call.tool}\u0000${call.op}\u0000${call.commandLine ?? ""}`,
        waiting: () => refusal(stillWaiting(machine, call)),
        budgetMs,
        arrivedAt: at,
    });
    const open = conversationId === undefined ? undefined : heldAsks.reattach(asked(conversationId));
    if (open !== undefined) {
        return open;
    }
    const stopping = guards.working(conversationId);
    if (stopping.length === 0) {
        return undefined;
    }
    // What the device refuses without its "Manage sandboxes" switch, asked first for the reason the command gate asks about
    // its destructive one: a card here could only end in a yes followed by the device refusing anyway.
    if ((await deviceScopesOf(services, machine))?.sandboxes === "off") {
        return refusal(switchedOff(machine, call));
    }
    const run = conversationId === undefined ? undefined : guards.turnRun(conversationId);
    if (conversationId === undefined || run === undefined || run.done || conversationUnattended(conversationId)) {
        return refusal(
            `Held for the owner: this would restart the sandbox you run in, which stops ${stopping.length} other ` +
                `${stopping.length === 1 ? "agent" : "agents"} working now (${stopping.join(", ")}), and there is nobody in this turn to ask. ` +
                `Do not retry it unasked: ask the owner in chat, or wait until they are idle.`,
        );
    }
    const { autoResumeOnRestart } = await services.sandboxSettings.get();
    // An answer nobody came back for is dropped with its turn: a later turn's same call is asked about afresh.
    return heldAsks.ask(asked(conversationId), {
        raise: (ended) => askOwner(guards, run, ended, { conversationId, machine, call, stopping, resumes: autoResumeOnRestart }),
        told: wakeWords({
            doing: `${call.tool} ${call.op} of this sandbox on "${machine}"`,
            ...opt("call", call.commandLine),
            notYet: "Nothing has run yet",
            again: "Make the same call now, with the same arguments.",
            declinedSo: "the sandbox was not restarted",
            refrain: "Do not restart the sandbox another way; say what is left undone until it can be.",
        }),
        held: guards.held,
        finished: run.waitUntilFinished(),
    });
};
