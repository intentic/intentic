import {
    type AdmissionPolicy,
    type AdmissionRule,
    COMMAND_CLASS_LABELS,
    type CommandClass,
    type CommandLocus,
    hardRuleClasses,
    type Trigger,
    type WakeSource,
} from "@intentic/sandbox-contract";
import { ALLOW, DENY, defineGuardedAction, HOLD } from "./guard.js";

// Action catalog: every gated decision, defined once and consulted by value. Policy arrives as input rather than being
// fetched here, so decides stay pure and a consult site can't see a different policy than it logs.

// Maps a trigger to its admission-floor key. `webchat` and `issues` get their own floor since a stranger can reach them
// without the owner wiring anything; every other listener shares `listener`.
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

// Listener providers with their own admission floor; a map keeps adding one to a single line here.
const LISTENER_SOURCES: Readonly<Record<string, WakeSource>> = { webchat: "webchat", issues: "issues" };

export interface SessionStartInput {
    readonly source: WakeSource;
    readonly admission: AdmissionPolicy;
    // Per-automation override; absent for doors with none (the workflow release gate).
    readonly requireApproval?: boolean;
    readonly holdForSeconds?: number;
}

// Most-restrictive-wins: deny beats hold beats the holdForSeconds countdown beats allow. Only a bare `holdForSeconds`
// hold carries an autoRun countdown; a floor or requireApproval hold is a plain ask.
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
    // Sniffer's classification of the call (activity/outbound.ts), e.g. `discord` + `message.send`.
    readonly provider: string;
    readonly type: string;
    // SandboxSettings.actionRules; an exact `<provider>.<type>` key wins over the `<provider>.*` wildcard.
    readonly rules: Readonly<Record<string, AdmissionRule>>;
}

// Consulted before an in-turn provider call runs. A hold can't park an unattended automation turn, so it becomes a
// refusal pointing at the approvals queue instead.
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
    // One of the classes the command fell in; a command in two classes is two consults, most-restrictive wins.
    readonly commandClass: CommandClass;
    // Which machine would run it, sandbox or device; the hard rule set differs per locus.
    readonly locus: CommandLocus;
    // Whether the flagged fragment would actually run, not just appear as text (heredoc, comment, quoted arg).
    readonly live: boolean;
}

// Hard rule for classes where nothing recovers (contract safety-policy.ts hardRuleClasses); no verdict can waive it.
// Narrowed only by locus (what a container can rebuild) and whether the fragment would actually run.
export const commandRun = defineGuardedAction<CommandRunInput>({
    action: "command.run",
    decide: ({ commandClass, locus, live }) => {
        // A mention is not an act; checked first since it's the cheaper question and the clearer log reason.
        if (!live) {
            return ALLOW(`this only mentions ${commandClass}, it does not do it`);
        }
        return hardRuleClasses(locus).has(commandClass)
            ? HOLD(`this command would ${COMMAND_CLASS_LABELS[commandClass]}, and nothing here undoes that`)
            : ALLOW(`the ${locus} hard rule does not cover ${commandClass}`);
    },
});

export interface CredentialUseInput {
    // Whether the owner gated this credential at all; false for most uses, so ALLOW is the common, cheap path.
    readonly gated: boolean;
    // Whether this conversation already holds a release for it, looked up by the caller and passed in as a fact.
    readonly granted: boolean;
    readonly unattended: boolean;
    // Whether a card can be raised at all: there is a live conversation to draw it in.
    readonly canPark: boolean;
}

// Consulted at every exit a credential can leave through. A hold asks a named approver, not whoever is looking; the
// only DENY is nobody available to ask, never a policy refusal.
export const credentialUse = defineGuardedAction<CredentialUseInput>({
    action: "credential.use",
    decide: ({ gated, granted, unattended, canPark }) => {
        if (!gated) {
            return ALLOW("no gate covers this credential");
        }
        if (granted) {
            return ALLOW("this conversation already holds a release for it");
        }
        if (unattended) {
            return DENY("this turn is running unattended, and a gated credential needs a named person's click");
        }
        if (!canPark) {
            return DENY("there is no live conversation to raise the release card in");
        }
        return HOLD("a named approver has to release this credential");
    },
});

export interface ChildSpawnInput {
    // Provider the child would run on; a specific rule wins over the general `agents.spawn` one.
    readonly provider: string;
    // SandboxSettings.actionRules, the same open rulebook the outbound gate reads.
    readonly rules: Readonly<Record<string, AdmissionRule>>;
    // What first brought outside content into the parent's turn (guard/turn-taint.ts), or undefined if none.
    readonly outsideSource?: string;
}

// Consulted on every supervisor mutation. A hold raises a card on the parent's turn since there's no held form of a
// spawn; it refuses only when nobody can ask. The taint floor applies only when the owner set no explicit rule.
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
