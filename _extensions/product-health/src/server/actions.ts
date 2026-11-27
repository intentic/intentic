import type { Finding } from "../wire.js";
import { ERROR_TRACKING_EVENTS, type PostHogClient } from "./posthog.js";
import { postsHere } from "./poller.js";
import type { StateDocument } from "./state.js";

/* WHAT A PRESS ON A FINDING CHANGES IN POSTHOG, each one a person's (routes.ts holds them to the maintainer floor): these
   land in a project other people read, so none is ever taken by the poller or an agent. Each keeps PostHog the source of
   truth: "mark fixed" resolves the issue there, and PostHog's own reopening of an error that comes back is what turns
   the row loud again (sources.ts, `cameBack`). */

// How long a snooze hides a finding.
const SNOOZE_MS = 7 * 24 * 60 * 60_000;

// A press a finding does not take, or a write PostHog cannot do for its source; said to the reader as it is.
export class ActionRefused extends Error {}

const dropFinding = (state: StateDocument, finding: Finding) =>
    state.update((current) => ({
        ...current,
        findings: { ...current.findings, [finding.connection]: (current.findings[finding.connection] ?? []).filter((held) => held.id !== finding.id) },
    }));

/** Marks a finding fixed in PostHog, and remembers when, so one that comes back reads as such. */
export const resolveFinding = async (client: PostHogClient, state: StateDocument, finding: Finding, now: number): Promise<void> => {
    if (finding.source === `error`) {
        await client.resolveError(finding.sourceId);
    } else if (finding.source === `health`) {
        await client.resolveHealth(finding.sourceId);
    } else if (finding.source === `report`) {
        await client.resolveReport(finding.sourceId);
    } else {
        throw new ActionRefused(`PostHog has no "fixed" for a${finding.source === `alert` || finding.source === `experiment` ? `n` : ``} ${finding.source}: it clears by itself`);
    }
    await state.update((current) => ({ ...current, resolved: { ...current.resolved, [finding.id]: now } }));
    await dropFinding(state, finding);
};

/** Dismisses one of PostHog's setup recommendations, in PostHog. */
export const dismissFinding = async (client: PostHogClient, state: StateDocument, finding: Finding): Promise<void> => {
    if (finding.source !== `setup`) {
        throw new ActionRefused(`only PostHog's setup advice is dismissed; snooze anything else`);
    }
    await client.dismissRecommendation(finding.sourceId);
    await dropFinding(state, finding);
};

/** Hides a finding for a week; a health issue's snooze is PostHog's own, so its page agrees. */
export const snoozeFinding = async (client: PostHogClient, state: StateDocument, finding: Finding, now: number): Promise<number> => {
    const until = now + SNOOZE_MS;
    if (finding.source === `health`) {
        await client.snoozeHealth(finding.sourceId, new Date(until));
    }
    await state.update((current) => ({ ...current, snoozed: { ...current.snoozed, [finding.id]: until } }));
    return until;
};

const EVENT_WORDS = {
    $error_tracking_issue_created: `new error`,
    $error_tracking_issue_reopened: `error came back`,
    $error_tracking_issue_spiking: `error spiking`,
} satisfies Record<(typeof ERROR_TRACKING_EVENTS)[number], string>;

/** Points PostHog's three error-tracking alerts at this sandbox's door, adding only the ones not already there. Answers
 *  how many it created. */
export const wireAlerts = async (client: PostHogClient, state: StateDocument, connection: string, hookUrl: string, token: string): Promise<number> => {
    const destinations = await client.alertDestinations();
    let created = 0;
    for (const event of ERROR_TRACKING_EVENTS) {
        if (destinations.some((destination) => postsHere(destination, event, token))) {
            continue;
        }
        await client.createWebhookAlert({ name: `Intentic Product health: ${EVENT_WORDS[event]}`, url: hookUrl, event });
        created += 1;
    }
    await state.update((current) => {
        const held = current.connections[connection];
        return held === undefined ? current : { ...current, connections: { ...current.connections, [connection]: { ...held, wired: true } } };
    });
    return created;
};
