import type { AdmissionPolicy, AdmissionRule, CommandClass, Trigger, WakeSource } from "@intentic/sandbox-contract";
import { COMMAND_CLASS_LABELS } from "./command-classes.js";
import { ALLOW, DENY, defineGuardedAction, HOLD } from "./guard.js";

/* The action catalog — every gated decision, defined once at this module edge and consulted by value.
 *
 * Policy rides IN as input (the settings snapshot the caller read) rather than being fetched here: the decides
 * stay pure, so the whole matrix is testable without a workspace, and a consult site can never observe a
 * different policy than the one it logs.
 */

// Which admission-floor key a wake falls under, from the automation's trigger. The webchat listener is its own
// source — a Doorbell visitor is a stranger on a public widget, which is not the same trust as a Discord
// channel the owner wired — and every other listener provider shares the "listener" rule.
export const wakeSourceOf = (trigger: Trigger): WakeSource => {
    switch (trigger.kind) {
        case "schedule":
            return "schedule";
        case "event":
            return "event";
        case "listener":
            return trigger.provider === "webchat" ? "webchat" : "listener";
        case "workspace":
            return "workspace";
    }
};

export interface SessionStartInput {
    readonly source: WakeSource;
    readonly admission: AdmissionPolicy;
    // The per-automation overrides, absent for doors that have none (the workflow release gate).
    readonly requireApproval?: boolean;
    readonly holdForSeconds?: number;
}

/* May this wake open (or continue) a session? Most-restrictive-wins across the floor and the per-object
 * overrides: deny beats hold beats the countdown beats allow. Only the pure `holdForSeconds` hold carries an
 * autoRun countdown — a hold the floor or `requireApproval` asked for is "ask me", and "ask me" must never
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
    // SandboxSettings.actionRules — exact `<provider>.<type>` key wins over the `<provider>.*` wildcard.
    readonly rules: Readonly<Record<string, AdmissionRule>>;
}

/* May this in-turn provider call run? Consulted by the PreToolUse outbound gate BEFORE the command executes —
 * the enforcing twin of the activity sniffer's after-the-fact audit. A "hold" cannot park a running turn
 * (automation turns run unattended; nobody may be there to answer), so the gate translates it into a refusal
 * that points at the drafts outbox — a draft awaiting owner approval IS the held form of a send. */
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
    // ONE of the classes the command fell in (guard/command-classes.ts). A command in two classes is two
    // consults, and the gate keeps the most restrictive answer — which is what makes "most restrictive wins"
    // observable at the consult site instead of hidden inside a decide that was handed a list.
    readonly commandClass: CommandClass;
    // SandboxSettings.commandRules. Unlisted ⇒ allowed: the rulebook names what to stop, not what to permit.
    readonly rules: Partial<Readonly<Record<CommandClass, AdmissionRule>>>;
    /* What first brought outside content into this turn (guard/turn-taint.ts) — a listener provider, "web", a
     * foreign MCP server — or undefined for a turn working only on the owner's own material. Present ⇒ the
     * turn has read text somebody else wrote, which is the condition the credential-read floor below keys on. */
    readonly outsideSource?: string;
}

/* May the agent run this shell command? Consulted by the PreToolUse command gate before the command executes.
 *
 * A "hold" here means the real thing, unlike outbound.send's: the gate raises a permission card and the command
 * waits for an answer. The difference is that a send has an approvable ARTIFACT to fall back on (the draft) and
 * a command does not — there is no held form of `git push --force`, only the command or not the command. So an
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
        /* THE TAINT FLOOR — the one rule here that the owner did not write, and the only place the outside-
         * content envelope becomes enforcement rather than narration (guard/turn-taint.ts explains why this
         * class and no other). A turn that has read somebody else's words does not get to read credential
         * material unasked; every other class is untouched, so the turn goes on editing, building and replying.
         *
         * Applied only where the owner has said NOTHING. An explicit `allow` is a decision about this exact
         * class — a workspace whose work IS reading credentials, say — and a floor that overrode it would be
         * this module deciding it knows better than the person who configured it. */
        if (rule === undefined && commandClass === "secrets.access" && outsideSource !== undefined) {
            return HOLD(
                `this turn has taken in content from outside (${outsideSource}), and this command would ${COMMAND_CLASS_LABELS[commandClass]}`,
            );
        }
        return ALLOW(`no command rule restricts ${commandClass}`);
    },
});
