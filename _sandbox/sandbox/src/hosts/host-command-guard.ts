import {
    COMMAND_CLASS_LABELS,
    type CommandClass,
    type CommandJudgeMode,
    type CommandLocus,
    DeviceScopesSchema,
    hardRuleClasses,
    matchCommand,
    type ProgramKind,
    type ProgramReading,
    programInCall,
    roleLadder,
    type SafetyVerdict,
} from "@intentic/sandbox-contract";
import { raiseRequest } from "../guard/card-offers.js";
import { RoleModelUnsetError } from "../seams/role-model-unset.js";
import type { LiveRun } from "../conversations/actor/conversation-holdings.js";
import type { Services } from "../composition.js";
import { commandRun } from "../guard/actions.js";
import { type HeldAnswer, createHeldAsks } from "../guard/held-asks.js";
import { wakeWords } from "../guard/held-cards.js";
import { guard } from "../guard/guard.js";
import { excerptProgram } from "../safety/safety-log.js";
import { conversationTaintSource, conversationUnattended } from "../guard/turn-taint.js";
import type { HostGuardDeps } from "./host-guard-deps.js";
import type { DeviceToolCall } from "./host-restart-guard.js";

// Applies the owner's safety policy to a command headed for their own device, before it crosses the tunnel. The daemon
// triages, judges and cards here since the machine itself can only allow or refuse, with no card to raise; this can
// only make the machine's decision stricter, never widen a scope. A card needs a live conversation, read from published
// turn state rather than the caller's word.

// How long the safety judge may take over one command before the standing rule decides alone.
const JUDGE_DEADLINE_MS = 10 * 60_000;

// How long one call waits here before answering, measured from its arrival: under the minute an agent's MCP client
// gives a call before it reports "The operation timed out." on its own, which an agent read as a broken \`rm\` and
// routed around. The card itself stays up until it is answered (guard/held-asks.ts); an answer given after this is kept
// for the same call.
const CALL_BUDGET_MS = 45_000;

// Which tools carry a program, and where in their arguments, is the contract's one table (policy/device-programs.ts):
// a command for the machine's own shell, one for the shell of an attached phone (run there as `adb shell <command>`), a
// program started with arguments or an application, URL or document opened, and text typed, pasted or set into a field
// where a terminal could run it. Every other tool (files, screen, browser, sandboxes) carries no program to classify.
const RUN_COMMAND = "run_command";

// Every command here leaves the container, so locus is fixed (mirrors SANDBOX in guard/command-guard.ts).
const DEVICE: CommandLocus = "device";

// What the model reads when the daemon stops a call; a value, not an error, so the agent reports it instead of
// retrying.
export interface HostGateRefusal {
    readonly refusal: string;
}

const refusal = (text: string): HostGateRefusal => ({ refusal: text });

// What the agent reads when nobody answered the card: no clock ends one, so only its turn ending (or being stopped) did.
const unanswered = (machine: string): string => `The turn ended before anyone answered, so it was not run on "${machine}". Do not retry it unasked.`;

// What the agent reads when its card is still open as its call must answer: nothing ran, the answer is kept, and the
// way to collect it is the same call again, never a different spelling of the same work. Ending the turn is safe too:
// the turn's close holds for the card and wakes the conversation with a yes (guard/held-cards.ts), which is said here
// so an agent that stops does not tell its owner something refused the call.
const LATER =
    `You may also carry on with other work or end your turn: the card stays up until they answer, and if they allow it ` +
    `you are told to make this call again. Nothing is broken on the device and nothing refused this, so do not report it ` +
    `as refused or blocked.`;
const stillWaiting = (machine: string, typed: boolean): string =>
    typed
        ? `Still waiting for the owner: a card asks them to approve typing this on "${machine}", and nothing has been typed yet. ` +
          `Their answer is kept for this exact text: make the same call again with exactly the same text to wait for it. ${LATER} ` +
          `Do not type a different command to do the same thing.`
        : `Still waiting for the owner: a card asks them to approve running this on "${machine}", and it has not run yet. ` +
          `Their answer is kept for this exact command: make the same call again, with exactly the same command, to wait for it. ${LATER} ` +
          `Do not run a different command to do the same thing.`;

// What the agent reads when the device's own "Run destructive commands" switch is off: the device would refuse the
// command whatever the owner answered, so no card is raised for a yes that cannot work.
const switchedOff = (machine: string, classes: readonly CommandClass[], typed: boolean): string =>
    `Refused: ${typed ? "typed into a terminal, this" : "this command"} would ${classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]).join(" and ")} on "${machine}", ` +
    `and its "Run destructive commands" switch is off, so the device would refuse it even if the owner approved. ` +
    `Ask the owner to turn on "Run destructive commands" in ${machine}'s capability card, or run a command that does not delete. ` +
    `Do not look for another spelling that gets past it.`;

// The device's own grant, read off its capability card; undefined when no card names it (the device decides then).
export const deviceScopesOf = async (services: Pick<Services, "capabilities" | "hosts">, machine: string) => {
    const card = services.hosts.cardFor(machine);
    const capability = (await services.capabilities.list()).find((entry) => entry.kind === "device" && entry.id === card);
    if (capability === undefined) {
        return undefined;
    }
    const parsed = DeviceScopesSchema.safeParse(capability.config);
    return parsed.success ? parsed.data : undefined;
};

// Cards still open (or answered and not yet collected) by the exact call that raised them, each held for its turn's
// close until a call collects it (guard/held-asks.ts).
const heldAsks = createHeldAsks<HostGateRefusal | undefined>();
const askKey = (machine: string, command: string): string => `${machine}\u0000${command}`;

/**
 * The program a device tool call carries, or undefined for a tool that carries none; a hostile or notification-shaped
 * payload is forwarded to the machine rather than gated, since there'd be nowhere to send a refusal (the bridge's schema
 * hands this only calls with an id). Text typed, pasted or set into a field is a program too: typing into a terminal IS
 * running a command, so it is judged the same way, by the same classifier: ordinary prose matches nothing and passes at
 * no cost, and `rm -rf ~` typed into a shell is asked about as if run_command had sent it.
 */
export const programOf = (call: DeviceToolCall): ProgramReading | undefined => programInCall(call.params.name, call.params.arguments ?? {});

// The judge's verdict and setting used, read live (no turn here to snapshot). Reads the same commandJudge switch as the
// sandbox gate; off means only that the daemon has no objection, the machine's scopes still decide.
const hostVerdict = async (
    services: Services,
    guards: HostGuardDeps,
    input: {
        readonly machine: string;
        readonly command: string;
        readonly consequences: readonly string[];
        readonly unattended: boolean;
        readonly outsideSource: string | undefined;
        // How the judge reads it: a shell command, or the plain launch of an application or document.
        readonly language: "bash" | "app launch";
    },
): Promise<{ readonly verdict: SafetyVerdict; readonly judging: CommandJudgeMode }> => {
    const [policy, settings] = await Promise.all([services.safetyPolicy.text(), services.sandboxSettings.get()]);
    const judging = settings.commandJudge;
    if (judging === "off") {
        return {
            judging,
            verdict: { decision: "allow", sentence: `The safety judge is turned off, so this was decided by the standing rule alone.` },
        };
    }
    const verdict = await guards.judge(
        {
            policy,
            program: input.command,
            ladder: roleLadder(settings, `safety-judge`),
            facts: {
                consequences: input.consequences,
                unattended: input.unattended,
                language: input.language,
                machine: input.machine,
                ...(input.outsideSource === undefined ? {} : { outsideSource: input.outsideSource }),
            },
        },
        AbortSignal.timeout(JUDGE_DEADLINE_MS),
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

// How the judge reads a program: a plain launch of an application or document reads as one, so a match on a path it
// opens does not read as a script.
const languageOf = (kind: ProgramKind): "bash" | "app launch" => (kind === "app-launch" ? "app launch" : "bash");

// The tool a card names and the words it asks in, by how the call carries its program.
const toolOfKind = (kind: ProgramKind): string => (kind === "typed" ? "device" : kind === "app-launch" ? "app_start" : RUN_COMMAND);
const cardTitle = (kind: ProgramKind, machine: string): string =>
    kind === "typed" ? `Type this on ${machine}?` : kind === "app-launch" ? `Start this on ${machine}?` : `Run this on ${machine}?`;
const cardDisplayName = (kind: ProgramKind, machine: string): string =>
    kind === "typed" ? `Type on ${machine}` : kind === "app-launch" ? `Start on ${machine}` : `Run on ${machine}`;

// The call a card asks about, and the moment its verdict was logged at, which is the log entry the answer amends.
interface DeviceAsk {
    readonly conversationId: string;
    readonly machine: string;
    readonly command: string;
    readonly sentence: string;
    readonly at: number;
    // Asked because of the owner's hard rule, which asks every time whatever stands in the conversation.
    readonly hard: boolean;
    // How the call carries it: typed into the device rather than run on it (the card says so, since nothing runs until
    // something reads it), run as a command, or started as an application.
    readonly kind: ProgramKind;
}

// How a card ended: `answer` is what the call answers (undefined forwards the command, a refusal is what the agent
// reads), `outcome` what a turn holding for the card wakes its conversation with.
type DeviceAnswer = HeldAnswer<HostGateRefusal | undefined>;

// Asks the owner on a card in the live turn and settles with their answer. `ended` settles the card at once: the turn's
// end (nobody answers a card in a turn that is over, and a yes given after it would run the command with nobody left to
// read what it did) or a stop while the turn's close held for it.
const askOwner = async (services: Services, guards: HostGuardDeps, run: LiveRun, ended: AbortSignal, ask: DeviceAsk): Promise<DeviceAnswer> => {
    const answerNotRecorded = (error: unknown): void =>
        services.logger.warn({ err: error, machine: ask.machine }, "safety log: the owner's answer on a device command was not recorded");
    const answered = await raiseRequest(
        guards.cards,
        { conversationId: ask.conversationId, push: (event) => run.push(event) },
        {
            kind: "permission",
            // Carries no words: an unanswered card is worded below, by whether the turn it was raised in is over.
            onAbort: { kind: "permission", requestId: "", decision: "deny" },
            // Card names the machine in its title: routine in a container, irreversible on somebody's actual laptop.
            raised: (requestId) => ({
                kind: "permission",
                requestId,
                toolName: `${ask.machine}__${toolOfKind(ask.kind)}`,
                title: cardTitle(ask.kind, ask.machine),
                displayName: cardDisplayName(ask.kind, ask.machine),
                // No marked spans: the title already says what matters here, that it runs on the machine, not the
                // container.
                program: { text: excerptProgram(ask.command), language: "bash", truncated: false, spans: [] },
                // `explain` and not `reason`: they would be the same sentence, printed twice on one card.
                explain: ask.sentence,
            }),
            approves: (answer) => answer.decision !== "deny",
            alwaysAsks: ask.hard,
            // The owner's own hard rule on their own machine: their devices hear of it even while they work elsewhere.
            insist: ask.hard,
            signal: ended,
        },
    );
    if (answered.decision === "unanswered") {
        void services.safetyLog.answered(ask.at, "unanswered", "refused").catch(answerNotRecorded);
        return { answer: refusal(unanswered(ask.machine)), outcome: { decision: "unanswered" } };
    }
    if (answered.decision === "declined") {
        void services.safetyLog.answered(ask.at, "declined", "refused").catch(answerNotRecorded);
        const feedback = answered.reply.feedback?.trim();
        return {
            answer: refusal(
                feedback || `The user declined this. Do not run it on "${ask.machine}", and do not look for another way to achieve the same thing.`,
            ),
            outcome: { decision: "declined", ...(feedback ? { feedback } : {}) },
        };
    }
    void services.safetyLog.answered(ask.at, "allowed", "allowed").catch(answerNotRecorded);
    return { answer: undefined, outcome: { decision: "approved" } };
};

// Judges one command headed for `machine`; undefined forwards it, a refusal answers the agent and never touches the
// tunnel. No live turn means no judgment (forwarded): there's no card, taint bit or policy snapshot to use, and the
// machine's own scopes still hold.
export const judgeHostCommand = async (
    services: Services,
    guards: HostGuardDeps,
    input: { readonly machine: string; readonly command: string; readonly conversationId: string | undefined; readonly kind: ProgramKind },
    budgetMs: number = CALL_BUDGET_MS,
): Promise<HostGateRefusal | undefined> => {
    const at = Date.now();
    const { kind } = input;
    // At `device` locus, paths mean the owner's machine, not an image: /usr, /etc, a Docker volume are real here.
    const matches = matchCommand(input.command, { locus: DEVICE });
    const classes = matches.map((match) => match.commandClass);
    // Tier 1: nothing matched, so nothing to judge and no model spent; most commands land here.
    if (matches.length === 0) {
        return undefined;
    }
    const conversationId = input.conversationId;
    const call = (id: string) => ({
        conversationId: id,
        key: askKey(input.machine, input.command),
        waiting: () => refusal(stillWaiting(input.machine, kind === "typed")),
        budgetMs,
        arrivedAt: at,
    });
    // The same call again, while its card is open or its answer uncollected: no second judge, no second card.
    const open = conversationId === undefined ? undefined : heldAsks.reattach(call(conversationId));
    if (open !== undefined) {
        return open;
    }
    // What the device itself refuses without its destructive switch, the same live reading its own shell makes: asked
    // first, since a card here could only end in "Allow once" followed by the device refusing anyway.
    const gated = matches.filter((match) => match.live && hardRuleClasses(DEVICE).has(match.commandClass)).map((match) => match.commandClass);
    if (gated.length > 0 && (await deviceScopesOf(services, input.machine))?.destructive === "off") {
        return refusal(switchedOff(input.machine, gated, kind === "typed"));
    }
    const run = conversationId === undefined ? undefined : guards.turnRun(conversationId);
    // Same `live` discipline as the sandbox gate: a command merely mentioning a delete does not count as one.
    const hard = matches.find(
        (match) => guard(commandRun, { commandClass: match.commandClass, locus: DEVICE, live: match.live }).effect !== "allow",
    )?.commandClass;
    // Told to the judge, never a refusal: whether anybody is watching the live turn right now.
    const unattended = conversationId === undefined || conversationUnattended(conversationId);
    const outsideSource = conversationId === undefined ? undefined : conversationTaintSource(conversationId);
    const { verdict, judging } = await hostVerdict(services, guards, {
        machine: input.machine,
        command: input.command,
        consequences: classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]),
        unattended,
        outsideSource,
        language: languageOf(kind),
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
            .catch((error: unknown) =>
                services.logger.warn({ err: error, machine: input.machine }, "safety log: a judged device command was not recorded"),
            );
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
    const ask = { conversationId, machine: input.machine, command: input.command, sentence: verdict.sentence, at, hard: hard !== undefined };
    return heldAsks.ask(call(conversationId), {
        raise: (ended) => askOwner(services, guards, run, ended, { ...ask, kind }),
        told: deviceWake(input.machine, input.command, kind === "typed"),
        held: guards.held,
        finished: run.waitUntilFinished(),
    });
};

// What a turn woken by the card's late answer reads: what to repeat, exactly, or the owner's note on a decline.
const deviceWake = (machine: string, command: string, typed: boolean) =>
    wakeWords({
        doing: `${typed ? "typing this" : "running this"} on "${machine}"`,
        call: command,
        notYet: `It has not ${typed ? "been typed" : "run"} yet`,
        again: typed
            ? "Type it now with exactly the same call: the same tool and exactly the same text."
            : "Run it now with exactly the same call: the same tool, the same command and the same arguments.",
        declinedSo: `it did not ${typed ? "get typed" : "run"}`,
        refrain: "Do not run it or anything that does the same thing.",
    });
