import {
    type AdmissionPolicy,
    type AdmissionRule,
    COMMAND_CLASS_LABELS,
    type CommandClass,
    FLOOR_CLASSES,
    type Trigger,
    type WakeSource,
} from "@intentic/sandbox-contract";
import { ALLOW, DENY, defineGuardedAction, HOLD } from "./guard.js";

/* The action catalog, every gated decision, defined once at this module edge and consulted by value.
 *
 * Policy rides IN as input (the settings snapshot the caller read) rather than being fetched here: the decides
 * stay pure, so the whole matrix is testable without a workspace, and a consult site can never observe a
 * different policy than the one it logs.
 */

/* Which admission-floor key a wake falls under, from the automation's trigger. Two listener providers are their
 * own source and everything else shares the "listener" rule, because those two are the ones a STRANGER can
 * reach without the owner having wired anything:
 *
 *   webchat  a visitor on a public widget, which is not the same trust as a Discord channel the owner set up.
 *   issues   a crash report from any browser on a site the owner listed, and the one whose floor is `hold`
 *            rather than `allow` (AdmissionPolicySchema argues why): the toolbox a bug-fix turn needs is the
 *            opposite of the Front Desk persona's, and the brief is a stack trace somebody else's machine wrote.
 */
export const wakeSourceOf = (trigger: Trigger): WakeSource => {
    switch (trigger.kind) {
        case "schedule":
            return "schedule";
        case "event":
            return "event";
        case "listener":
            return LISTENER_SOURCES[trigger.provider] ?? "listener";
        case "workspace":
            return "workspace";
    }
};

// The listener providers that carry their own admission floor. A map rather than a chain of ternaries: the next
// one added is a line here, and the set is small and closed on purpose.
const LISTENER_SOURCES: Readonly<Record<string, WakeSource>> = { webchat: "webchat", issues: "issues" };

export interface SessionStartInput {
    readonly source: WakeSource;
    readonly admission: AdmissionPolicy;
    // The per-automation overrides, absent for doors that have none (the workflow release gate).
    readonly requireApproval?: boolean;
    readonly holdForSeconds?: number;
}

/* May this wake open (or continue) a session? Most-restrictive-wins across the floor and the per-object
 * overrides: deny beats hold beats the countdown beats allow. Only the pure `holdForSeconds` hold carries an
 * autoRun countdown, a hold the floor or `requireApproval` asked for is "ask me", and "ask me" must never
 * become "unless I'm slow". */
export const sessionStart = defineGuardedAction<SessionStartInput>({
    action: "session.start",
    decide: ({ source, admission, requireApproval, holdForSeconds }) => {
        const floor = admission[source];
        if (floor === "deny") {
            return DENY(`${source} sessions are refused by the admission policy`);
        }
        if (requireApproval === true) {
            return HOLD("this automation asks for approval on every wake");
        }
        if (floor === "hold") {
            return HOLD(`${source} sessions are held for approval by the admission policy`);
        }
        if (holdForSeconds !== undefined) {
            return HOLD(`held for ${holdForSeconds}s unless approved or rejected first`, holdForSeconds);
        }
        return ALLOW(`admission policy allows ${source} sessions`);
    },
});

export interface OutboundSendInput {
    // The sniffer's classification of the call (activity/outbound.ts matchers): "discord" + "message.send".
    readonly provider: string;
    readonly type: string;
    // SandboxSettings.actionRules, exact `<provider>.<type>` key wins over the `<provider>.*` wildcard.
    readonly rules: Readonly<Record<string, AdmissionRule>>;
}

/* May this in-turn provider call run? Consulted by the PreToolUse outbound gate BEFORE the command executes,
 * the enforcing twin of the activity sniffer's after-the-fact audit. A "hold" cannot park a running turn
 * (automation turns run unattended; nobody may be there to answer), so the gate translates it into a refusal
 * that points at the drafts outbox, a draft awaiting owner approval IS the held form of a send. */
export const outboundSend = defineGuardedAction<OutboundSendInput>({
    action: "outbound.send",
    decide: ({ provider, type, rules }) => {
        const rule = rules[`${provider}.${type}`] ?? rules[`${provider}.*`] ?? "allow";
        if (rule === "deny") {
            return DENY(`${provider} ${type} is refused by the action rules`);
        }
        if (rule === "hold") {
            return HOLD(`${provider} ${type} requires owner approval`);
        }
        return ALLOW(`no action rule restricts ${provider} ${type}`);
    },
});

export interface CommandRunInput {
    // ONE of the classes the command fell in (sandbox-contract's command-classes.ts). A command in two classes is two
    // consults, and the gate keeps the most restrictive answer, which is what makes "most restrictive wins"
    // observable at the consult site instead of hidden inside a decide that was handed a list.
    readonly commandClass: CommandClass;
    // SandboxSettings.commandRules. Unlisted ⇒ allowed: the rulebook names what to stop, not what to permit.
    readonly rules: Partial<Readonly<Record<CommandClass, AdmissionRule>>>;
    /* What first brought outside content into this turn (guard/turn-taint.ts), a listener provider, "web", a
     * foreign MCP server, or undefined for a turn working only on the owner's own material. Present ⇒ the
     * turn has read text somebody else wrote, which is the condition the taint floor below keys on. */
    readonly outsideSource?: string;
}

/* THE CLASSES A TAINTED TURN DOES NOT GET FOR FREE. Both are things a turn carrying somebody else's words
 * should have to ask about, and neither is something an ordinary turn should have to ask about:
 *
 *   secrets.access    a turn that has read a stranger's page does not get to read credential material unasked.
 *   files.destructive the same page's other obvious ask. `rm -rf node_modules` is ordinary work and stays
 *                     unasked all day; the same command in a turn that just read a bug report from a Front
 *                     Desk visitor is the injection everybody pictures, and one card is a cheap way to not
 *                     find out which it was afterwards.
 *
 * Everything else is untouched, so a tainted turn goes on editing, building, committing and replying. */
const TAINT_FLOOR_CLASSES: ReadonlySet<CommandClass> = new Set<CommandClass>(["secrets.access", "files.destructive"]);

/* May the agent run this shell command? Consulted by the PreToolUse command gate before the command executes.
 *
 * A "hold" here means the real thing, unlike outbound.send's: the gate raises a permission card and the command
 * waits for an answer. The difference is that a send has an approvable ARTIFACT to fall back on (the draft) and
 * a command does not, there is no held form of `git push --force`, only the command or not the command. So an
 * unattended turn, with nobody to raise the card to, gets the refusal instead; the gate words that, because
 * whether anyone is watching is a property of the turn and not of the policy. */
export const commandRun = defineGuardedAction<CommandRunInput>({
    action: "command.run",
    decide: ({ commandClass, rules, outsideSource }) => {
        const rule = rules[commandClass];
        if (rule === "deny") {
            return DENY(`commands that ${COMMAND_CLASS_LABELS[commandClass]} are refused by the command rules`);
        }
        if (rule === "hold") {
            return HOLD(`the command rules hold commands that ${COMMAND_CLASS_LABELS[commandClass]} for your approval`);
        }
        /* TWO FLOORS, the rules here that the owner did not write. Both apply ONLY where the owner has said
         * NOTHING: an explicit `allow` is a decision about this exact class, a workspace whose work IS reading
         * credentials or wiping volumes, say, and a floor that overrode it would be this module deciding it
         * knows better than the person who configured it.
         *
         * THE STANDING FLOOR. `commandRules` is an empty rulebook until somebody opens the settings, and for
         * everything recoverable that is the right default: the container is disposable and gating ordinary
         * work is friction bought with nothing. It is the wrong default for the handful of commands that leave
         * nothing to recover FROM (contract command-classes.ts FLOOR_CLASSES says which and argues the line).
         * A fresh sandbox should not be one mistyped path away from a formatted disk, and "we assumed you had
         * configured it" is not an answer anybody wants after the fact.
         *
         * The cost is stated where it is paid: `enforcing` in guard/turn-gate.ts is now true on every turn,
         * so the vendor runtimes whose gate is their own approval channel ask per command rather than never. */
        if (rule === undefined && FLOOR_CLASSES.has(commandClass)) {
            return HOLD(`this command would ${COMMAND_CLASS_LABELS[commandClass]}, and nothing here undoes that`);
        }
        /* THE TAINT FLOOR, the only place the outside-content envelope becomes enforcement rather than
         * narration (guard/turn-taint.ts explains the bit; TAINT_FLOOR_CLASSES above argues the two classes). */
        if (rule === undefined && outsideSource !== undefined && TAINT_FLOOR_CLASSES.has(commandClass)) {
            return HOLD(
                `this turn has taken in content from outside (${outsideSource}), and this command would ${COMMAND_CLASS_LABELS[commandClass]}`,
            );
        }
        return ALLOW(`no command rule restricts ${commandClass}`);
    },
});

export interface ChildSpawnInput {
    // The provider the child would run on, so a rule can single one out ("agents.spawn.cursor") or cover the
    // whole surface ("agents.spawn"). The specific key wins, the outbound gate's own precedence shape.
    readonly provider: string;
    // SandboxSettings.actionRules, the same open rulebook the outbound gate reads.
    readonly rules: Readonly<Record<string, AdmissionRule>>;
    /* What first brought outside content into the PARENT's turn (guard/turn-taint.ts), or undefined for a
     * turn working only on the owner's own material. Present ⇒ the parent has read text somebody else wrote,
     * which is the condition the floor below keys on. */
    readonly outsideSource?: string;
}

/* May this turn start, steer or answer a CHILD AGENT? Consulted by the child service on every supervisor
 * mutation (children/children.ts), which is what makes the rule bind on every door at once — the harness
 * tools, Cursor's custom tools, and the `agents` CLI all land on the same consult.
 *
 * A "hold" cannot park here (a spawn may arrive from a shell whose turn has already ended, with nobody to
 * raise a card to), so the service translates it into a refusal that names the owner — outbound.send's own
 * shape, where the held form of the action is "ask the owner in chat".
 *
 * THE TAINT FLOOR rides this action too, and for the wallet's reason: a child spends the owner's connected
 * accounts on the parent's say-so, and a parent that has read a hostile page is exactly the judgment that
 * page may have replaced. Applied only where the owner has said NOTHING: an explicit `allow` is a decision
 * about this workspace, and the floor must not override the person who configured it. */
export const childSpawn = defineGuardedAction<ChildSpawnInput>({
    action: "agents.spawn",
    decide: ({ provider, rules, outsideSource }) => {
        const rule = rules[`agents.spawn.${provider}`] ?? rules["agents.spawn"];
        if (rule === "deny") {
            return DENY(`spawning child agents on ${provider} is refused by the action rules`);
        }
        if (rule === "hold") {
            return HOLD(`spawning child agents on ${provider} requires owner approval`);
        }
        if (rule === undefined && outsideSource !== undefined) {
            return HOLD(
                `this turn has taken in content from outside (${outsideSource}), and a child agent would spend the owner's accounts on its say-so`,
            );
        }
        return ALLOW(`no action rule restricts spawning child agents on ${provider}`);
    },
});
