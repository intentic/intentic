import {
    COMMAND_CLASS_LABELS,
    type CommandJudgeMode,
    type CommandLocus,
    matchCommand,
    type SafetyVerdict,
} from "@intentic/sandbox-contract";
import { judgeCommand } from "../agent/tools/command-judge.js";
import { raiseCard } from "../agent/run/offer-card.js";
import { RoleModelUnsetError } from "../agent/models/role-model-unset.js";
import { turnRunOf } from "../agent/run/turn/turn-runs.js";
import type { Services } from "../composition.js";
import { commandRun } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import { excerptProgram } from "../safety/safety-log.js";
import { conversationTaintSource, conversationUnattended } from "../guard/turn-taint.js";

// Applies the owner's safety policy to a command headed for their own device, before it crosses the tunnel. The daemon
// triages, judges and cards here since the machine itself can only allow or refuse, with no card to raise; this can
// only make the machine's decision stricter, never widen a scope. A card needs a live conversation, read from published
// turn state rather than the caller's word.

// How long a device-command card waits: long enough to return to, short of the hub's connection ceiling.
const DEADLINE_MS = 10 * 60_000;

// The only call shape this gate judges: file, screen and input tools carry no program to classify.
const RUN_COMMAND = "run_command";

// Every command here leaves the container, so locus is fixed (mirrors SANDBOX in guard/command-gate.ts).
const DEVICE: CommandLocus = "device";

// What the model reads when the daemon stops a call; a value, not an error, so the agent reports it instead of
// retrying.
export interface HostGateRefusal {
    readonly refusal: string;
}

const refusal = (text: string): HostGateRefusal => ({ refusal: text });

// The command inside a run_command tools/call, or undefined for anything else; a hostile or notification-shaped payload
// is forwarded to the machine rather than gated, since there'd be nowhere to send a refusal.
export const commandInCall = (payload: unknown): string | undefined => {
    const request = payload as { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (request.id === undefined || request.method !== "tools/call" || request.params?.name !== RUN_COMMAND) {
        return undefined;
    }
    const command = (request.params.arguments as Record<string, unknown> | undefined)?.["command"];
    return typeof command === "string" && command.trim() !== "" ? command : undefined;
};

// The judge's verdict and setting used, read live (no turn here to snapshot). Reads the same commandJudge switch as the
// sandbox gate; off means only that the daemon has no objection, the machine's scopes still decide.
const hostVerdict = async (
    services: Services,
    input: {
        readonly machine: string;
        readonly command: string;
        readonly consequences: readonly string[];
        readonly unattended: boolean;
        readonly outsideSource: string | undefined;
    },
): Promise<{ readonly verdict: SafetyVerdict; readonly judging: CommandJudgeMode }> => {
    const [policy, settings] = await Promise.all([services.safetyPolicy.text(), services.sandboxSettings.get()]);
    const judging = settings.commandJudge;
    if (judging === "off") {
        return { judging, verdict: { decision: "allow", sentence: `The safety judge is turned off, so this was decided by the standing rule alone.` } };
    }
    const verdict = await judgeCommand(
        services,
        {
            policy,
            program: input.command,
            pins: settings.modelRoles[`safety-judge`] ?? [],
            facts: {
                consequences: input.consequences,
                unattended: input.unattended,
                language: "bash",
                machine: input.machine,
                ...(input.outsideSource === undefined ? {} : { outsideSource: input.outsideSource }),
            },
        },
        AbortSignal.timeout(DEADLINE_MS),
    ).catch(
        // A judge that cannot run leaves the hard rule standing; the rest passes through to the machine's own scopes.
        (error: unknown): SafetyVerdict => ({
            decision: "allow",
            sentence:
                error instanceof RoleModelUnsetError
                    ? `No model is set for the safety judge, so this was decided by the standing rule alone.`
                    : `The safety judge could not be reached, so this was decided by the standing rule alone.`,
        }),
    );
    return { verdict, judging };
};

// Judges one command headed for `machine`; undefined forwards it, a refusal answers the agent and never touches the
// tunnel. No live turn means no judgment (forwarded): there's no card, taint bit or policy snapshot to use, and the
// machine's own scopes still hold.
export const judgeHostCommand = async (
    services: Services,
    input: { readonly machine: string; readonly command: string; readonly conversationId: string | undefined },
): Promise<HostGateRefusal | undefined> => {
    // At `device` locus, paths mean the owner's machine, not an image: /usr, /etc, a Docker volume are real here.
    const matches = matchCommand(input.command, { locus: DEVICE });
    const classes = matches.map((match) => match.commandClass);
    // Tier 1: nothing matched, so nothing to judge and no model spent; most commands land here.
    if (matches.length === 0) {
        return undefined;
    }
    const at = Date.now();
    const conversationId = input.conversationId;
    const run = conversationId === undefined ? undefined : turnRunOf(conversationId);
    // Same `live` discipline as the sandbox gate: a command merely mentioning a delete does not count as one.
    const hard = matches.find(
        (match) => guard(commandRun, { commandClass: match.commandClass, locus: DEVICE, live: match.live }).effect !== "allow",
    )?.commandClass;
    const unattended = conversationId === undefined || conversationUnattended(conversationId);
    const outsideSource = conversationId === undefined ? undefined : conversationTaintSource(conversationId);
    const { verdict, judging } = await hostVerdict(services, {
        machine: input.machine,
        command: input.command,
        consequences: classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]),
        unattended,
        outsideSource,
    });
    // Only "on" lets the verdict decide; "off"/"watch" just log it, and the hard rule can only tighten the result.
    const enforced = judging === "on" ? verdict.decision : "allow";
    const decision = hard !== undefined && enforced === "allow" ? "ask" : enforced;
    // Logs the judge's own decision, not the enforced one: an "ask" beside "allowed" means watch mode would refuse.
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
        // Nothing was judged at "off", so no row is written: it would only repeat the setting back to the log.
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
        // The unaskable case: a detached call or an ended turn, with no stream left to draw a card in.
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
    record("asked");
    const { reply } = await raiseCard(
        { observe: services.agents.observe },
        { conversationId, push: (event) => run.push(event) },
        {
            kind: "permission",
            onAbort: { kind: "permission", requestId: "", decision: "deny", feedback: "The turn ended before you answered." },
            // Card names the machine in its title: routine in a container, irreversible on somebody's actual laptop.
            raised: (requestId) => ({
                kind: "permission",
                requestId,
                toolName: `${input.machine}__${RUN_COMMAND}`,
                title: `Run this on ${input.machine}?`,
                displayName: `Run on ${input.machine}`,
                // No marked spans: the title already says what matters here, that it runs on the machine, not the
                // container.
                program: { text: excerptProgram(input.command), language: "bash", truncated: false, spans: [] },
                // `explain` and not `reason`: they would be the same sentence, printed twice on one card.
                explain: verdict.sentence,
            }),
            deadlineMs: DEADLINE_MS,
        },
    );
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
