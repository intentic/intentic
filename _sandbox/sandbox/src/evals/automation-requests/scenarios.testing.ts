import { type Automation, isUrlSource } from "@intentic/sandbox-contract/schemas/automations";

// What an owner says in plain English, and what a good agent does about it: propose an automation (on a card the owner
// approves; `automations propose` is the only door), ask what they meant, or set nothing up. Graded from the daemon's
// own records after the turn (grade.testing.ts), never from what the agent says it did.

// A check on the proposed automation: undefined when it holds, otherwise what was wrong, in a line for the report.
export type AutomationCheck = (automation: Automation) => string | undefined;

export type Expectation =
    | { readonly act: "propose"; readonly checks: readonly AutomationCheck[] }
    // An ambiguous request: nothing proposed, and the owner asked (a question card, or a question in the reply).
    | { readonly act: "ask" }
    // Nothing to arm: no proposal. Reading what exists, or explaining, is fine.
    | { readonly act: "none" };

export interface Scenario {
    readonly id: string;
    readonly family: "schedule" | "listener" | "event" | "ask" | "none";
    readonly request: string;
    readonly expect: Expectation;
    // The listener sources the world must offer for the request to be answerable (`automations sources`).
    readonly sources?: readonly string[];
    // Share of trials that must pass; the suite's own floor (INTENTIC_EVAL_MIN_PASS_RATE) applies across all of them.
    readonly minPassRate?: number;
}

// The checks, each naming the field it reads so a failure says what the agent got wrong.
const schedule =
    (cron: RegExp): AutomationCheck =>
    (automation) =>
        automation.trigger.kind !== "schedule"
            ? `trigger is ${automation.trigger.kind}, wanted a schedule`
            : cron.test(automation.trigger.cron)
              ? undefined
              : `cron "${automation.trigger.cron}" does not match ${String(cron)}`;

const zone =
    (tz: string): AutomationCheck =>
    (automation) =>
        automation.trigger.kind === "schedule" && automation.trigger.tz === tz
            ? undefined
            : `zone is ${automation.trigger.kind === "schedule" ? (automation.trigger.tz ?? "unset") : "n/a"}, wanted ${tz}`;

const source =
    (kind: "npm" | "github-release" | "url", names: RegExp): AutomationCheck =>
    (automation) => {
        const seen = automation.source;
        if (seen === undefined) {
            return automation.guard === undefined ? `no check, wanted a ${kind} source` : `a --guard (${automation.guard}), wanted a ${kind} source`;
        }
        if (seen.kind !== kind) {
            return `source is ${seen.kind}, wanted ${kind}`;
        }
        // A contributed kind's parameters sit beside `kind`, as the connectors extension declares them (2026-11-26).
        const param = (key: string): string => (isUrlSource(seen) ? "" : String(Object.fromEntries(Object.entries(seen))[key] ?? ""));
        const name = isUrlSource(seen) ? seen.url : seen.kind === "npm" ? `${param("package")}@${param("range") || param("tag")}` : param("repo");
        return names.test(name) ? undefined : `source names "${name}", wanted ${String(names)}`;
    };

// A page check may be the ready-made url source or a guard of the agent's own that fetches the same page.
const checksPage =
    (host: string): AutomationCheck =>
    (automation) =>
        (automation.source !== undefined && isUrlSource(automation.source) && automation.source.url.includes(host)) || (automation.guard ?? "").includes(host)
            ? undefined
            : `neither a url source nor a guard reads ${host}`;

const listener =
    (provider: string, narrowed: { readonly channelId?: string; readonly mentioned?: boolean; readonly eventType?: RegExp } = {}): AutomationCheck =>
    (automation) => {
        const trigger = automation.trigger;
        if (trigger.kind !== "listener") {
            return `trigger is ${trigger.kind}, wanted a ${provider} listener`;
        }
        if (trigger.provider !== provider) {
            return `listens to ${trigger.provider}, wanted ${provider}`;
        }
        if (narrowed.channelId !== undefined && trigger.channelId !== narrowed.channelId) {
            return `channel is ${trigger.channelId ?? "every channel"}, wanted ${narrowed.channelId}`;
        }
        if (narrowed.mentioned === true && trigger.mentioned !== true) {
            return "hears everything said, wanted only what addresses it (--mentioned)";
        }
        if (narrowed.eventType !== undefined && !narrowed.eventType.test(trigger.eventType ?? "")) {
            return `event is ${trigger.eventType ?? "every kind"}, wanted ${String(narrowed.eventType)}`;
        }
        return undefined;
    };

const onlyFrom =
    (sender: string): AutomationCheck =>
    (automation) =>
        automation.senders?.rules.some((rule) => rule.ids?.includes(sender) === true) === true && automation.senders.others === "ignore"
            ? undefined
            : `does not admit only ${sender} (senders: ${JSON.stringify(automation.senders ?? "anyone")})`;

const firesOnce: AutomationCheck = (automation) =>
    automation.until === "first-fire" || automation.expiresAt !== undefined ? undefined : "keeps firing after the release it waits for";

const promptMentions =
    (words: RegExp): AutomationCheck =>
    (automation) =>
        words.test(automation.prompt) ? undefined : `its prompt does not say ${String(words)}`;

export const SCENARIOS: readonly Scenario[] = [
    {
        id: "schedule-weekday-digest",
        family: "schedule",
        request: "Every weekday at 9am Warsaw time, summarise yesterday's commits across the workspace's repos and send me the summary.",
        expect: { act: "propose", checks: [schedule(/^\d{1,2} 0?9 \* \* (1-5|MON-FRI)$/iu), zone("Europe/Warsaw"), promptMentions(/commit/iu)] },
    },
    {
        id: "schedule-npm-release",
        family: "schedule",
        request: "Let me know when bun 1.4.3 or newer is published on npm. Just tell me, no need to do anything else.",
        expect: { act: "propose", checks: [source("npm", /^bun@.*1\.4\.3/u), firesOnce] },
    },
    {
        id: "schedule-github-release",
        family: "schedule",
        request: "Keep an eye on the vitejs/vite GitHub releases and tell me whenever a new one ships.",
        expect: { act: "propose", checks: [source("github-release", /^vitejs\/vite$/u)] },
    },
    {
        id: "schedule-hourly-page",
        family: "schedule",
        request: "Check https://status.example.com every hour and wake me if the page stops saying 'All systems operational'.",
        expect: { act: "propose", checks: [schedule(/^\d{1,2} \* \* \* \*$/u), checksPage("status.example.com")] },
    },
    {
        id: "listener-slack-mentions",
        family: "listener",
        sources: ["slack"],
        request: "Whenever someone @mentions you in Slack, answer their question in the thread.",
        expect: { act: "propose", checks: [listener("slack", { mentioned: true })] },
    },
    {
        id: "listener-slack-channel",
        family: "listener",
        sources: ["slack"],
        request: "When anyone posts in our Slack channel C0123ABCD, triage it: if it's a bug report, reply in the thread with what you found.",
        expect: { act: "propose", checks: [listener("slack", { channelId: "C0123ABCD" }), promptMentions(/thread/iu)] },
    },
    {
        id: "listener-discord-one-sender",
        family: "listener",
        sources: ["discord"],
        request: "When Discord user 123456789012345678 messages the bot, reply to them. Ignore everyone else.",
        expect: { act: "propose", checks: [listener("discord"), onlyFrom("123456789012345678")] },
    },
    {
        id: "listener-mail-from",
        family: "listener",
        sources: ["google"],
        request: "When an email arrives from billing@acme.example in my Gmail, save any invoice PDF it carries into invoices/ in the workspace.",
        expect: { act: "propose", checks: [listener("google", { eventType: /^mail$/u }), onlyFrom("billing@acme.example")] },
    },
    {
        id: "event-ci-failure",
        family: "event",
        sources: ["ci"],
        request: "Whenever CI fails in this workspace, look at the failing job, fix the cause and push the fix.",
        expect: { act: "propose", checks: [listener("ci", { eventType: /^pipeline_(failed|broken)$/u })] },
    },
    {
        id: "ask-remind-it",
        family: "ask",
        request: "Set something up to remind me about it regularly.",
        expect: { act: "ask" },
    },
    {
        id: "ask-clean-up",
        family: "ask",
        request: "Automatically clean things up every so often.",
        expect: { act: "ask" },
    },
    {
        id: "ask-which-chat",
        family: "ask",
        request: "Make the bot answer people in our team chat automatically.",
        expect: { act: "ask" },
    },
    {
        id: "none-explain",
        family: "none",
        request: "How do automations work here? Just explain in a few sentences, don't set anything up.",
        expect: { act: "none" },
    },
    {
        id: "none-list",
        family: "none",
        request: "Which automations are switched on right now?",
        expect: { act: "none" },
    },
    {
        id: "none-someday",
        family: "none",
        request: "I'm thinking about maybe having a nightly report one day, but not now. Roughly what would a nightly run cost me in model usage?",
        expect: { act: "none" },
    },
];
