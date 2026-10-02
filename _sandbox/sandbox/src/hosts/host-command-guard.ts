import {
    COMMAND_CLASS_LABELS,
    type CommandClass,
    type CommandJudgeMode,
    type CommandLocus,
    DeviceScopesSchema,
    hardRuleClasses,
    matchCommand,
    type SafetyVerdict,
} from "@intentic/sandbox-contract";
import { judgeCommand } from "../agent/tools/command-judge.js";
import { cardDeps, raiseRequest } from "../conversations/actor/card-offers.js";
import { RoleModelUnsetError } from "../seams/role-model-unset.js";
import { type LiveRun, turnRunOf } from "../conversations/actor/conversation-holdings.js";
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

// How long one call waits here before answering, measured from its arrival: under the minute an agent's MCP client
// gives a call before it reports "The operation timed out." on its own, which an agent read as a broken \`rm\` and
// routed around. The card itself stays up for DEADLINE_MS; an answer given after this is kept for the same call.
const CALL_BUDGET_MS = 45_000;

// The only call shape this gate judges: file, screen and input tools carry no program to classify.
const RUN_COMMAND = "run_command";

// Every command here leaves the container, so locus is fixed (mirrors SANDBOX in guard/command-guard.ts).
const DEVICE: CommandLocus = "device";

// What the model reads when the daemon stops a call; a value, not an error, so the agent reports it instead of
// retrying.
export interface HostGateRefusal {
    readonly refusal: string;
}

const refusal = (text: string): HostGateRefusal => ({ refusal: text });

// What the agent reads when nobody answered the card: the deadline passed with its turn still running, or the turn ended
// first. Only an agent still working reads the first, which is why it says what to do next.
const unanswered = (machine: string, turnEnded: boolean): string =>
    turnEnded
        ? `The turn ended before anyone answered, so it was not run on "${machine}". Do not retry it unasked.`
        : `Nobody answered within ${DEADLINE_MS / 60_000} minutes, so it was not run on "${machine}". ` +
          `Do not retry it unasked: carry on without it and say what was left undone.`;

// What the agent reads when its card is still open as its call must answer: nothing ran, the answer is kept, and the
// way to collect it is the same call again, never a different spelling of the same work.
const stillWaiting = (machine: string): string =>
    `Still waiting for the owner: a card asks them to approve running this on "${machine}", and it has not run yet. ` +
    `Their answer is kept for this exact command: call run_command again with exactly the same command to wait for it. ` +
    `Nothing is broken on the device. Do not run a different command to do the same thing.`;

// What the agent reads when the device's own "Run destructive commands" switch is off: the device would refuse the
// command whatever the owner answered, so no card is raised for a yes that cannot work.
const switchedOff = (machine: string, classes: readonly CommandClass[]): string =>
    `Refused: this command would ${classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]).join(" and ")} on "${machine}", ` +
    `and its "Run destructive commands" switch is off, so the device would refuse it even if the owner approved. ` +
    `Ask the owner to turn on "Run destructive commands" in ${machine}'s capability card, or run a command that does not delete. ` +
    `Do not look for another spelling that gets past it.`;

// The device's own grant, read off its capability card; undefined when no card names it (the device decides then).
const deviceScopesOf = async (services: Services, machine: string) => {
    const card = services.hosts.cardFor(machine);
    const capability = (await services.capabilities.list()).find((entry) => entry.kind === "device" && entry.id === card);
    if (capability === undefined) {
        return undefined;
    }
    const parsed = DeviceScopesSchema.safeParse(capability.config);
    return parsed.success ? parsed.data : undefined;
};

// Cards still open (or answered and not yet collected) by the exact call that raised them, so the agent calling again
// with the same command waits on the same card, and a yes given after its first call gave up still runs it once.
const openAsks = new Map<string, Promise<HostGateRefusal | undefined>>();
const askKey = (conversationId: string, machine: string, command: string): string => `${conversationId}\u0000${machine}\u0000${command}`;

// Waits on an open card for what is left of this call's budget: its answer (collected, so it is used once), or the
// still-waiting note with the card left up.
const awaitAnswer = async (key: string, asking: Promise<HostGateRefusal | undefined>, machine: string, budgetMs: number): Promise<HostGateRefusal | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"waiting">((resolve) => {
        timer = setTimeout(() => resolve("waiting"), Math.max(0, budgetMs));
    });
    try {
        const outcome = await Promise.race([asking, waited]);
        if (outcome === "waiting") {
            return refusal(stillWaiting(machine));
        }
        if (openAsks.get(key) === asking) {
            openAsks.delete(key);
        }
        return outcome;
    } finally {
        clearTimeout(timer);
    }
};

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

// The call a card asks about, and the moment its verdict was logged at, which is the log entry the answer amends.
interface DeviceAsk {
    readonly conversationId: string;
    readonly machine: string;
    readonly command: string;
    readonly sentence: string;
    readonly at: number;
    // Asked because of the owner's hard rule, which asks every time whatever stands in the conversation.
    readonly hard: boolean;
}

// Asks the owner on a card in the live turn and holds the call until it settles: undefined forwards the command, a
// refusal is what the agent reads for the way the card ended.
const askOwner = async (services: Services, run: LiveRun, ask: DeviceAsk): Promise<HostGateRefusal | undefined> => {
    const answerNotRecorded = (error: unknown): void =>
        services.logger.warn({ err: error, machine: ask.machine }, "safety log: the owner's answer on a device command was not recorded");
    // The turn's end settles the card at once: nobody answers a card in a turn that is over, and a yes given after it
    // would run the command with nobody left to read what it did.
    const ended = new AbortController();
    void run.waitUntilFinished().then(() => ended.abort());
    const answered = await raiseRequest(
        cardDeps(services),
        { conversationId: ask.conversationId, push: (event) => run.push(event) },
        {
            kind: "permission",
            // Carries no words: an unanswered card is worded below, by whether the turn it was raised in is over.
            onAbort: { kind: "permission", requestId: "", decision: "deny" },
            // Card names the machine in its title: routine in a container, irreversible on somebody's actual laptop.
            raised: (requestId) => ({
                kind: "permission",
                requestId,
                toolName: `${ask.machine}__${RUN_COMMAND}`,
                title: `Run this on ${ask.machine}?`,
                displayName: `Run on ${ask.machine}`,
                // No marked spans: the title already says what matters here, that it runs on the machine, not the
                // container.
                program: { text: excerptProgram(ask.command), language: "bash", truncated: false, spans: [] },
                // `explain` and not `reason`: they would be the same sentence, printed twice on one card.
                explain: ask.sentence,
            }),
            approves: (answer) => answer.decision !== "deny",
            alwaysAsks: ask.hard,
            signal: ended.signal,
            deadlineMs: DEADLINE_MS,
        },
    );
    if (answered.decision === "unanswered") {
        void services.safetyLog.answered(ask.at, "unanswered", "refused").catch(answerNotRecorded);
        return refusal(unanswered(ask.machine, ended.signal.aborted));
    }
    if (answered.decision === "declined") {
        void services.safetyLog.answered(ask.at, "declined", "refused").catch(answerNotRecorded);
        return refusal(
            answered.reply.feedback?.trim() ||
                `The user declined this. Do not run it on "${ask.machine}", and do not look for another way to achieve the same thing.`,
        );
    }
    void services.safetyLog.answered(ask.at, "allowed", "allowed").catch(answerNotRecorded);
    return undefined;
};

// Judges one command headed for `machine`; undefined forwards it, a refusal answers the agent and never touches the
// tunnel. No live turn means no judgment (forwarded): there's no card, taint bit or policy snapshot to use, and the
// machine's own scopes still hold.
export const judgeHostCommand = async (
    services: Services,
    input: { readonly machine: string; readonly command: string; readonly conversationId: string | undefined },
    budgetMs: number = CALL_BUDGET_MS,
): Promise<HostGateRefusal | undefined> => {
    const at = Date.now();
    // At `device` locus, paths mean the owner's machine, not an image: /usr, /etc, a Docker volume are real here.
    const matches = matchCommand(input.command, { locus: DEVICE });
    const classes = matches.map((match) => match.commandClass);
    // Tier 1: nothing matched, so nothing to judge and no model spent; most commands land here.
    if (matches.length === 0) {
        return undefined;
    }
    const conversationId = input.conversationId;
    // The same call again, while its card is open or its answer uncollected: no second judge, no second card.
    const key = conversationId === undefined ? undefined : askKey(conversationId, input.machine, input.command);
    const open = key === undefined ? undefined : openAsks.get(key);
    if (key !== undefined && open !== undefined) {
        return awaitAnswer(key, open, input.machine, budgetMs - (Date.now() - at));
    }
    // What the device itself refuses without its destructive switch, the same live reading its own shell makes: asked
    // first, since a card here could only end in "Allow once" followed by the device refusing anyway.
    const gated = matches.filter((match) => match.live && hardRuleClasses(DEVICE).has(match.commandClass)).map((match) => match.commandClass);
    if (gated.length > 0 && (await deviceScopesOf(services, input.machine))?.destructive === "off") {
        return refusal(switchedOff(input.machine, gated));
    }
    const run = conversationId === undefined ? undefined : turnRunOf(services.conversations, conversationId);
    // Same `live` discipline as the sandbox gate: a command merely mentioning a delete does not count as one.
    const hard = matches.find(
        (match) => guard(commandRun, { commandClass: match.commandClass, locus: DEVICE, live: match.live }).effect !== "allow",
    )?.commandClass;
    // Told to the judge, never a refusal: whether anybody is watching the live turn right now.
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
        void services.safetyLog
            .record({ at, ...entry, outcome, ...(answer === undefined ? {} : { answer }) })
            .catch((error: unknown) => services.logger.warn({ err: error, machine: input.machine }, "safety log: a judged device command was not recorded"));
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
    // Asked whoever started the turn: a card nobody has answered yet waits for the owner, it is not a refusal.
    record("asked");
    const asking = askOwner(services, run, {
        conversationId,
        machine: input.machine,
        command: input.command,
        sentence: verdict.sentence,
        at,
        hard: hard !== undefined,
    });
    const ownKey = askKey(conversationId, input.machine, input.command);
    openAsks.set(ownKey, asking);
    // An answer nobody came back for is dropped with its turn: a later turn's same command is asked about afresh.
    void run.waitUntilFinished().then(() => {
        if (openAsks.get(ownKey) === asking) {
            openAsks.delete(ownKey);
        }
    });
    return awaitAnswer(ownKey, asking, input.machine, budgetMs - (Date.now() - at));
};
