import { type AgentEvent, COMMAND_CLASS_LABELS, classifyCommand, type SafetyVerdict } from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import { judgeCommand } from "../agent/command-judge.js";
import { turnRunOf } from "../agent/turn-runs.js";
import type { Services } from "../composition.js";
import { commandRun } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import { excerptProgram } from "../safety/safety-log.js";
import { conversationTaintSource, conversationUnattended } from "../guard/turn-taint.js";

/* THE OWNER'S SAFETY POLICY, APPLIED TO A COMMAND HEADED FOR THEIR OWN DEVICE, before it crosses the tunnel.
 *
 * WHAT THIS FIXED, and it is the sharpest gap the old design had. Enforcement for a connected machine lives on
 * the machine (machine/src/device/policy.ts), which is correct and does not change here: the sandbox can be
 * compromised, so it must not be the thing that decides. But the machine has exactly two answers — the
 * `destructive` scope is on, or it is off — and it cannot park a card, because there is no person at the far end
 * of a WebSocket. So the owner's only choices were "this agent may delete things on my laptop, always" and "it
 * may not, ever", with no way to say "ask me". In practice that meant the switch stayed off and the agent
 * reported a refusal every time the job actually needed it.
 *
 * The daemon can ask, and the daemon is the one thing on the path that sees the call before it leaves
 * (hosts/host.routes.ts forwards every `tools/call`). So triage → judge → card runs HERE, against the machines
 * section of the policy, and the scope on the machine stays underneath as the hard floor. Two consequences worth
 * stating plainly:
 *
 *   · This is FRICTION, not a boundary, exactly like the sandbox's own gate. An agent that talks its way past
 *     the judge still meets the scope switch on the machine, which is the thing the security argument rests on.
 *     Nothing here can widen a scope, and the scopes are deliberately not in the editable policy document.
 *   · It can only ever make the machine STRICTER. A refusal or an unanswered card stops a command the machine
 *     might have run; an allow here is not permission, it just means the daemon had no objection of its own.
 *
 * WHY IT NEEDS A CONVERSATION. A card has to be drawn somewhere, and this code runs in the HTTP layer while the
 * turn that called the tool is parked inside an MCP request. The conversation id rides on the bridge URL
 * (capabilities/host-tools.ts says why that is a routing hint and not a credential), and everything else about
 * the turn is read from the published live-turn state rather than taken on the caller's word.
 */

// How long a card about somebody's own device waits for an answer. The supervisor's window (children.ts) and
// for its reason: long enough that somebody who stepped away can still come back, short enough that a dead
// client cannot hold an MCP call open for the hub's whole ceiling.
const DEADLINE_MS = 10 * 60_000;

// The tool the machine exposes for running a command, and the field it carries it in. The only call shape this
// gate judges: the file tools are bounded by the machine's own roots, and the screen and input tools have no
// program in them to classify.
const RUN_COMMAND = "run_command";

// What the model reads when the daemon stops the call. A VALUE rather than an error, the same choice policy.ts
// makes on the machine: it travels back as an ordinary tool result, so the agent tells the owner what happened
// instead of reporting a broken sandbox and retrying.
export interface HostGateRefusal {
    readonly refusal: string;
}

const refusal = (text: string): HostGateRefusal => ({ refusal: text });

/* The command inside a `tools/call` for `run_command`, or undefined when this is any other call. Nothing here
 * throws on a hostile shape: the payload is whatever crossed the bridge, and a call whose arguments are not the
 * shape we expect is forwarded to the machine, which is the only party that can say what it means.
 *
 * AN ID IS REQUIRED, because a refusal has to travel back as an answer and a JSON-RPC notification has nowhere
 * to put one. `tools/call` is a request in the protocol, so a notification-shaped one is malformed either way;
 * this simply declines to gate what it could not report on, and lets the machine's own scopes have it. */
export const commandInCall = (payload: unknown): string | undefined => {
    const request = payload as { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (request.id === undefined || request.method !== "tools/call" || request.params?.name !== RUN_COMMAND) {
        return undefined;
    }
    const command = (request.params.arguments as Record<string, unknown> | undefined)?.["command"];
    return typeof command === "string" && command.trim() !== "" ? command : undefined;
};

/* Judge one command headed for `machine`. Undefined ⇒ forward it. A refusal ⇒ answer the agent with its text and
 * never touch the tunnel.
 *
 * NO LIVE TURN ⇒ NO JUDGMENT, and the command is forwarded. That is the honest answer rather than a permissive
 * one: without a turn there is no card to raise, no taint bit and no policy snapshot, and the thing on the far
 * end still enforces every scope the owner ticked. Refusing here instead would break the detached paths (a CLI
 * call, a turn that has already settled) in exchange for no boundary that the machine does not already hold. */
export const judgeHostCommand = async (
    services: Services,
    input: { readonly machine: string; readonly command: string; readonly conversationId: string | undefined },
): Promise<HostGateRefusal | undefined> => {
    const classes = classifyCommand(input.command);
    // TIER 1. Nothing matched, so nothing to judge and no model spent — the same economy the sandbox's own gate
    // runs on, and most of what an agent sends a machine lands here.
    if (classes.length === 0) {
        return undefined;
    }
    const at = Date.now();
    const conversationId = input.conversationId;
    const run = conversationId === undefined ? undefined : turnRunOf(conversationId);
    const hard = classes.find((commandClass) => guard(commandRun, { commandClass }).effect !== "allow");
    const unattended = conversationId === undefined || conversationUnattended(conversationId);
    const outsideSource = conversationId === undefined ? undefined : conversationTaintSource(conversationId);
    /* THE SAME SWITCH THE SANDBOX'S OWN GATE READS (settings.commandJudge), applied to the same three tiers, so
     * an owner who turned the judge off is not still being asked about their laptop. Read live rather than
     * snapshotted, unlike the sandbox gate's, because this call arrives outside any turn's planning: there is no
     * moment here that a snapshot could belong to.
     *
     * IT LOOSENS NOTHING THAT MATTERS. Everything below is friction the daemon adds on top of the machine's own
     * scopes, and the scopes are not reachable from this document or this setting — an off judge means the daemon
     * has no objection of its own and the machine decides, which is where the security argument always rested. */
    const [policy, settings] = await Promise.all([services.safetyPolicy.text(), services.sandboxSettings.get()]);
    const judging = settings.commandJudge;
    const verdict: SafetyVerdict =
        judging === "off"
            ? { decision: "allow", sentence: `The safety judge is turned off, so this was decided by the standing rule alone.` }
            : await judgeCommand(
                  services,
                  {
                      policy,
                      program: input.command,
                      models: settings.commandJudgeModels,
                      facts: {
                          consequences: classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]),
                          unattended,
                          language: "bash",
                          machine: input.machine,
                          ...(outsideSource === undefined ? {} : { outsideSource }),
                      },
                  },
                  AbortSignal.timeout(DEADLINE_MS),
              ).catch(
                  // A judge that cannot run leaves the hard rule standing and lets everything else through to the
                  // machine, where the scopes decide. Same posture and reasoning as the sandbox gate's fallback.
                  (): SafetyVerdict => ({
                      decision: "allow",
                      sentence: `The safety judge could not be reached, so this was decided by the standing rule alone.`,
                  }),
              );
    // Only at `on` does the verdict decide anything; at `off` and `watch` it is evidence for the log and the hard
    // rule is the whole gate. Which the hard rule can then only make stricter, never looser.
    const enforced = judging === "on" ? verdict.decision : "allow";
    const decision = hard !== undefined && enforced === "allow" ? "ask" : enforced;
    // The row carries the JUDGE'S own word rather than the enforced one, which is what the schema says it holds:
    // an `ask` beside an outcome of `allowed` is a watched sandbox saying "this would have stopped you".
    const entry = {
        program: excerptProgram(input.command),
        classes,
        decision: verdict.decision,
        sentence: verdict.sentence,
        machine: input.machine,
    };
    const record = (outcome: "allowed" | "asked" | "refused", answer?: "allowed" | "declined"): void => {
        void services.safetyLog.record({ at, ...entry, outcome, ...(answer === undefined ? {} : { answer }) }).catch(() => undefined);
    };
    if (decision === "allow") {
        // Nothing was judged at `off`, so there is no verdict to write down: a row per flagged command saying
        // "allowed, because nobody looked" only repeats the setting back to whoever reads the log.
        if (judging !== "off") {
            record("allowed");
        }
        return undefined;
    }
    if (decision === "refuse") {
        record("refused");
        return refusal(`Refused: ${verdict.sentence} Your owner's safety policy does not allow this on "${input.machine}". Do not retry.`);
    }
    if (conversationId === undefined || run === undefined || run.done) {
        // The genuinely unaskable door, worded as children.ts words its own: a detached call or a turn that has
        // already ended, where there is no stream to draw a card in.
        record("refused");
        return refusal(
            `Held for the owner: ${verdict.sentence} This call arrived outside a live turn, so there was nowhere to ask them. ` +
                `Ask in chat before running it on "${input.machine}".`,
        );
    }
    if (unattended) {
        record("refused");
        return refusal(
            `Held for the owner: ${verdict.sentence} This turn is running unattended, so there is nobody to approve it. ` +
                `Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
        );
    }
    const { id, wait } = createRequest(
        "permission",
        { kind: "permission", requestId: "", decision: "deny", feedback: "The turn ended before you answered." },
        conversationId,
    );
    record("asked");
    /* The card names the MACHINE in its title, because that is the fact that changes the answer: the same
     * command is ordinary in a disposable container and irreversible on somebody's laptop, and a card that read
     * like every other command card would be asking the owner the wrong question. */
    const raised: AgentEvent = {
        kind: "permission",
        requestId: id,
        toolName: `${input.machine}__${RUN_COMMAND}`,
        title: `Run this on ${input.machine}?`,
        displayName: `Run on ${input.machine}`,
        /* No marked spans. Triage found the fragments, but the card's marks exist to say WHICH part of four
         * hundred characters stopped it, and this card's title already says the answer the owner is weighing:
         * that it runs on their laptop rather than in the container. */
        program: { text: excerptProgram(input.command), language: "bash", truncated: false, spans: [] },
        // `explain` and not `reason`: they would be the same sentence, printed twice on one card.
        explain: verdict.sentence,
    };
    run.push(raised);
    services.agents.observe(conversationId, raised);
    const { reply, resolved } = await wait(AbortSignal.timeout(DEADLINE_MS));
    // Every parked card owes the stream its resolution frame: it is what stops a client rendering the card as
    // live, and the only honest account of how long the call was parked.
    run.push(resolved);
    services.agents.observe(conversationId, resolved);
    if (reply.decision === "deny") {
        void services.safetyLog.answered(at, "declined", "refused").catch(() => undefined);
        return refusal(
            reply.feedback?.trim() ||
                `The user declined this. Do not run it on "${input.machine}", and do not look for another way to achieve the same thing.`,
        );
    }
    void services.safetyLog.answered(at, "allowed", "allowed").catch(() => undefined);
    return undefined;
};
