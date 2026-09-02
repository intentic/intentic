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
 * that points at the approvals queue, a post awaiting owner approval IS the held form of a send. */
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
    /* Does this same command ALSO reach the internet (network.outbound)? Read only by the taint floor, and only
     * for `secrets.access` — see taintFloorHolds. The gate computes it from the classes it already matched, so
     * one walk of the command answers both "what is this" and "does it leave". */
    readonly egress?: boolean;
}

/* WHAT A TAINTED TURN DOES NOT GET FOR FREE, and the shape of each answer.
 *
 *   files.destructive  every one of them. `rm -rf node_modules` is ordinary work and stays unasked all day; the
 *                      same command in a turn that just read a bug report from a Front Desk visitor is the
 *                      injection everybody pictures, and one card is a cheap way to not find out which it was
 *                      afterwards. Nothing here brings the tree back, so the ask is worth its cost.
 *
 *   secrets.access     ONLY WHEN IT ALSO LEAVES. This used to hold every credential read, and the reasoning was
 *                      sound as far as it went: outside text arrives, the agent is talked into reading a
 *                      credential, the credential leaves, and the middle link is where a policy can stand. What
 *                      it missed is that the middle link no longer carries the value. Every tool result is
 *                      masked before the model sees it — stored values to their `{{secret:name}}` reference, and
 *                      the rest of a credential file to `***` because the call named that file (agent/agent-
 *                      redaction.ts) — so a tainted turn that reads a dotenv learns its key names. Holding that
 *                      spent a card on nothing, and the cards it spent were mostly not even reads: a grep whose
 *                      pattern contained a credential-shaped name, a config the agent had to open to do the work
 *                      it was woken for. A card an owner answers without reading is worse than no card.
 *
 *                      What still leaks is the command that carries the file OUT — `curl -d @.env`, a
 *                      `{{secret:X}}` resolved into a request body — and that is exactly a command in this class
 *                      AND in `network.outbound`. So the floor moved from the read to the send.
 *
 *                      THE GAP IT ACCEPTS, stated plainly: two commands do what one no longer can (`cp .env
 *                      /tmp/x`, then `curl -d @/tmp/x`), because the classifier judges one command at a time and
 *                      the second names no credential. The gate has never claimed to be the boundary
 *                      (sandbox-contract command-classes.ts says so at length), and a floor that fires on the work
 *                      the agent was woken to do buys nothing to cover a hole this shape.
 *
 * Everything else is untouched, so a tainted turn goes on editing, building, committing and replying. */
const taintFloorHolds = (commandClass: CommandClass, egress: boolean): boolean =>
    commandClass === "files.destructive" || (commandClass === "secrets.access" && egress);

/* May the agent run this shell command? Consulted by the PreToolUse command gate before the command executes.
 *
 * A "hold" here means the real thing, unlike outbound.send's: the gate raises a permission card and the command
 * waits for an answer. The difference is that a send has an approvable ARTIFACT to fall back on (the draft) and
 * a command does not, there is no held form of `git push --force`, only the command or not the command. So an
 * unattended turn, with nobody to raise the card to, gets the refusal instead; the gate words that, because
 * whether anyone is watching is a property of the turn and not of the policy. */
export const commandRun = defineGuardedAction<CommandRunInput>({
    action: "command.run",
    decide: ({ commandClass, rules, outsideSource, egress = false }) => {
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
         * narration (guard/turn-taint.ts explains the bit; taintFloorHolds above argues each class). */
        if (rule === undefined && outsideSource !== undefined && taintFloorHolds(commandClass, egress)) {
            // The sending is what is being asked about when a read is held, so the sentence says both halves;
            // anything else would put a card in front of the owner that describes the harmless one.
            const consequence = egress
                ? `${COMMAND_CLASS_LABELS[commandClass]} and ${COMMAND_CLASS_LABELS["network.outbound"]}`
                : COMMAND_CLASS_LABELS[commandClass];
            return HOLD(`this turn has taken in content from outside (${outsideSource}), and this command would ${consequence}`);
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
 * A "hold" ASKS. The service raises a permission card on the parent's own turn and waits (children/children.ts
 * askOwner), which is commandRun's shape rather than outbound.send's, and for commandRun's reason: there is no
 * held form of a spawn the way a draft is the held form of a send — there is the child or there is not.
 *
 * It refuses only where there is genuinely nobody to ask, and that is decided by looking rather than guessing:
 * a live turn run for the parent conversation is a stream to draw a card in, and its absence is the detached
 * `agents` shell or a turn that has already ended. This used to refuse unconditionally on the grounds that the
 * detached case exists, which made the common case (a watched turn, the owner right there) unanswerable.
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
