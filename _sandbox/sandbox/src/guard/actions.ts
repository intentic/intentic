import type { AdmissionPolicy, AdmissionRule, Trigger, WakeSource } from "@intentic/sandbox-contract";
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
