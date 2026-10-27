import type { ActivityEvent, ActivityQuery, ActivityStatus } from "@intentic/sandbox-contract/schemas/activity";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { DEP_AUDIT_AGENT_ID, FEATURED_AGENT_ID, TRIAGE_AUTOMATION_ID } from "../../fixture/fleet";
import { deskEdition, freshEdition } from "../../mode";
import { STARTED_AT } from "./roster";

// The audit feed of what the agent did out in the world (activity.list), as the daemon appends it: the on-call
// listener answering a mention in #eng-alerts, the nightly audit Discord kicked off, the inbox triage the clock wakes, and
// the owner's own turns. Read-only, like the daemon's: nothing a visitor presses writes here. A desk or a fresh sandbox
// has no connections and has done nothing outside yet.

const minutesAgo = (count: number): number => STARTED_AT - count * 60_000;
const ENG_ALERTS = `1180-eng-alerts`;

// One turn's entries, tied by its turn id as the daemon ties them: what woke it, what it sent, how it ended.
const turn = (
    id: string,
    at: number,
    rest: Pick<ActivityEvent, `conversationId` | `title` | `origin` | `automationIds` | `actor` | `account`>,
    steps: readonly Omit<ActivityEvent, `id` | `turnId`>[],
): ActivityEvent[] =>
    steps.map((step, index) => ({
        ...rest,
        ...step,
        id: `act_${id}_${index}`,
        at: step.at ?? at + index * 9_000,
        turnId: `turn_${id}`,
    }));

const discordReply = (): ActivityEvent[] => {
    const at = minutesAgo(52);
    const origin = { automationId: `discord-oncall`, provider: `discord`, channelId: ENG_ALERTS, author: `Grace Hopper` };
    return turn(`oncall`, at, { conversationId: `cnv_discord_reply`, title: `Why is checkout returning 502s?`, origin, automationIds: [`discord-oncall`], account: `acc_claude_demo` }, [
        { at, provider: `discord`, direction: `in`, type: `message.received`, channelId: ENG_ALERTS, author: `Grace Hopper`, content: `@intentic checkout is throwing 502s on staging since the last deploy, any idea why?` },
        { at: at + 2_000, direction: `system`, type: `turn.started` },
        { at: at + 61_000, provider: `discord`, direction: `out`, type: `message.send`, channelId: ENG_ALERTS, method: `POST`, endpoint: `/channels/${ENG_ALERTS}/messages`, content: `The staging deploy is missing STRIPE_WEBHOOK_SECRET, so api/src/routes/checkout.ts:41 throws before it answers. Adding it to the staging secrets fixes it.` },
        { at: at + 63_000, direction: `system`, type: `turn.completed`, outcome: `ok`, extra: { costUsd: 0.06, durationMs: 61_000 } },
    ]);
};

const nightlyAudit = (): ActivityEvent[] => {
    const at = minutesAgo(420);
    const origin = { automationId: `nightly-audit`, provider: `discord`, channelId: ENG_ALERTS, author: `#eng-alerts` };
    return turn(`audit`, at, { conversationId: DEP_AUDIT_AGENT_ID, title: `Nightly dependency audit`, origin, automationIds: [`nightly-audit`], account: `ops@acme.dev` }, [
        { at, direction: `system`, type: `automation.run` },
        { at: at + 1_000, direction: `system`, type: `turn.started` },
        { at: at + 1_680_000, provider: `discord`, direction: `out`, type: `message.send`, channelId: ENG_ALERTS, method: `POST`, endpoint: `/channels/${ENG_ALERTS}/messages`, content: `Nightly audit: 3 advisories, 2 patched on agent/dep-audit, 1 in an installed extension needs a look.` },
        { at: at + 1_700_000, direction: `system`, type: `turn.completed`, outcome: `ok`, extra: { costUsd: 0.14, durationMs: 1_699_000 } },
    ]);
};

const triage = (ago: number): ActivityEvent[] => {
    const at = minutesAgo(ago);
    const id = `a-${TRIAGE_AUTOMATION_ID}-${at.toString(36)}`;
    return turn(`triage_${ago}`, at, { conversationId: id, title: `Triage new support emails`, origin: { automationId: TRIAGE_AUTOMATION_ID, provider: `schedule` }, automationIds: [TRIAGE_AUTOMATION_ID] }, [
        { at, direction: `system`, type: `automation.run` },
        { at: at + 1_000, direction: `system`, type: `turn.started` },
        { at: at + 40_000, direction: `system`, type: `turn.completed`, outcome: `ok`, extra: { costUsd: 0.02, durationMs: 39_000 } },
    ]);
};

const ownTurn = (): ActivityEvent[] => {
    const at = minutesAgo(9);
    return turn(`checkout`, at, { conversationId: FEATURED_AGENT_ID, title: `Add Stripe checkout to the pricing page`, actor: `ada@acme.dev`, account: `acc_claude_demo` }, [
        { at, direction: `system`, type: `turn.started` },
        { at: at + 30_000, provider: `stripe`, direction: `out`, type: `api.call`, method: `GET`, endpoint: `/v1/prices?active=true` },
    ]);
};

// A sign-in the gateway lost overnight, and got back: the error the rail names until a newer one replaces it.
const gatewayBlip = (): ActivityEvent[] => [
    { id: `act_gateway_lost`, at: minutesAgo(610), provider: `discord`, direction: `system`, type: `gateway.login_failed`, outcome: `error`, error: `The Discord gateway closed the session (4009, timed out); reconnected 40 seconds later.` },
];

const FEED: readonly ActivityEvent[] =
    deskEdition || freshEdition
        ? []
        : [...ownTurn(), ...discordReply(), ...[30, 90, 150, 210].flatMap(triage), ...nightlyAudit(), ...gatewayBlip()].toSorted((a, b) => b.at - a.at);

// Newest first, paged by `before` (exclusive), narrowed to one source when asked.
export const activityList = ({ provider, limit, before }: ActivityQuery): SandboxHandlerOutput<`activity`, `list`> => ({
    events: FEED.filter((event) => (provider === undefined || event.provider === provider) && (before === undefined || event.at < before)).slice(0, limit),
});

export const activityStatus = (): ActivityStatus =>
    deskEdition || freshEdition
        ? { connections: [] }
        : { connections: [{ capabilityId: `discord`, provider: `discord`, gateway: `ready`, lastError: `The Discord gateway closed the session (4009, timed out); reconnected 40 seconds later.` }] };
