import type { ActivityEvent, ActivityStatus } from "@intentic/sandbox-contract";
import { sinceOf, withinWindow } from "@intentic/extension-ui";
import { expect, test } from "vitest";
import { byDay, DIRECT, matches, SCHEDULE, sourceKeyOf, toEpisodes, toSources } from "./episodes.js";

/* The grouping IS the feature — a wrong join here renders somebody else's turn under your Discord bot, which is
 * worse than the flat list it replaced. Fixtures are the shapes real appends produce (agent.routes.ts's record(),
 * outbound.ts's sniffer, listeners.ts's inbound), including the two that made the old view unreadable: a
 * turn.started that has no sessionId yet, and a turn whose title only exists by the time it completes. */

const at = (minutes: number): number => Date.UTC(2026, 7, 2, 12, 0, 0) + minutes * 60_000;

const event = (fields: Partial<ActivityEvent> & Pick<ActivityEvent, "id" | "at" | "direction" | "type">): ActivityEvent => fields;

// One turn as the daemon writes it, newest first — the order /activity serves.
const TURN: ActivityEvent[] = [
    event({
        id: `e4`,
        at: at(4),
        direction: `system`,
        type: `turn.completed`,
        provider: `claude`,
        turnId: `t1`,
        conversationId: `c1`,
        title: `Redesign the activity view`,
        sessionId: `s1`,
        extra: { costUsd: 7.24, durationMs: 110_318 },
    }),
    event({ id: `e3`, at: at(3), direction: `out`, type: `message.send`, provider: `discord`, turnId: `t1`, channelId: `999`, content: `on it` }),
    event({ id: `e2`, at: at(2), direction: `out`, type: `messages.read`, provider: `discord`, turnId: `t1`, channelId: `999` }),
    // The prompt-bearing mark: no sessionId (the runtime has not reported one) and no title yet (the auto-namer
    // is still running). Both absences are why the log had to grow turnId.
    event({
        id: `e1`,
        at: at(0),
        direction: `system`,
        type: `turn.started`,
        provider: `claude`,
        turnId: `t1`,
        conversationId: `c1`,
        content: `Go for it.`,
    }),
];

test("a turn's lifecycle marks and its outbound calls collapse into one episode carrying the whole story", () => {
    const [episode, ...rest] = toEpisodes(TURN);
    expect(rest).toEqual([]);
    expect(episode).toMatchObject({
        key: `t1`,
        kind: `turn`,
        at: at(0),
        label: `Redesign the activity view`,
        detail: `Go for it.`,
        runtime: `claude`,
        sessionId: `s1`,
        failed: false,
        durationMs: 110_318,
        costUsd: 7.24,
        outbound: 2,
    });
    // Every raw row stays reachable, oldest first — collapsing must not mean discarding.
    expect(episode?.events.map((entry) => entry.id)).toEqual([`e1`, `e2`, `e3`, `e4`]);
});

test("a titleless turn falls back to the prompt's first line, not to a uuid", () => {
    const untitled = TURN.filter((entry) => entry.title === undefined);
    expect(toEpisodes(untitled)[0]?.label).toBe(`Go for it.`);
});

test("a turn is filed under what woke it, never under the runtime that served it", () => {
    const woken = TURN.map((entry) =>
        entry.direction === `system`
            ? { ...entry, origin: { automationId: `deploy-watch`, provider: `discord`, channelId: `999`, author: `alice` } }
            : entry,
    );
    const [episode] = toEpisodes(woken);
    expect(episode).toMatchObject({ sourceKey: `discord`, runtime: `claude`, author: `alice`, channelId: `999` });
});

test("a turn nobody triggered is the user's own work", () => {
    expect(toEpisodes(TURN)[0]?.sourceKey).toBe(DIRECT);
    expect(sourceKeyOf(TURN[0] as ActivityEvent)).toBe(DIRECT);
});

test("a failed turn carries the failure onto its own row rather than a separate one", () => {
    const failed = [
        event({
            id: `f2`,
            at: at(2),
            direction: `system`,
            type: `turn.error`,
            provider: `claude`,
            turnId: `t2`,
            outcome: `error`,
            error: `401 revoked`,
        }),
        event({ id: `f1`, at: at(1), direction: `system`, type: `turn.started`, provider: `claude`, turnId: `t2`, content: `land it` }),
    ];
    const [episode, ...rest] = toEpisodes(failed);
    expect(rest).toEqual([]);
    expect(episode).toMatchObject({ failed: true, error: `401 revoked`, label: `land it` });
});

test("events written before turns carried an id stay one episode each, labelled by content not by type", () => {
    const legacy = TURN.map(({ turnId: _turnId, ...rest }) => rest as ActivityEvent);
    const episodes = toEpisodes(legacy);
    expect(episodes).toHaveLength(4);
    // The prompt-bearing mark leads with the prompt and demotes "Turn started" to a chip; the bare completion has
    // no content and so is named by its type.
    expect(episodes.map(({ label, typeName }) => ({ label, typeName }))).toEqual([
        { label: `Turn completed`, typeName: undefined },
        { label: `on it`, typeName: `Message sent` },
        { label: `Messages read`, typeName: undefined },
        { label: `Go for it.`, typeName: `Turn started` },
    ]);
});

test("an inbound message reads as its own text and files under the provider that received it", () => {
    const inbound = event({
        id: `m1`,
        at: at(1),
        direction: `in`,
        type: `message.received`,
        provider: `discord`,
        channelId: `999`,
        author: `alice`,
        content: `hey can you check the deploy\nsecond line`,
        automationIds: [`deploy-watch`],
    });
    expect(toEpisodes([inbound])[0]).toMatchObject({
        kind: `message`,
        sourceKey: `discord`,
        label: `hey can you check the deploy`,
        author: `alice`,
    });
});

test("a provider-less automation wake is a schedule, not the user", () => {
    const cron = event({ id: `a1`, at: at(1), direction: `system`, type: `automation.run`, automationIds: [`nightly`], outcome: `ok` });
    expect(toEpisodes([cron])[0]?.sourceKey).toBe(SCHEDULE);
});

test("episodes come back newest first regardless of how the pages interleaved", () => {
    const mixed = [...TURN, event({ id: `z`, at: at(9), direction: `in`, type: `message.received`, provider: `slack`, content: `later` })];
    expect(toEpisodes(mixed).map((episode) => episode.at)).toEqual([at(9), at(0)]);
});

const connection = (
    provider: string,
    gateway: ActivityStatus["connections"][number]["gateway"],
    id = provider,
): ActivityStatus["connections"][number] => ({
    capabilityId: id,
    provider,
    gateway,
});

test("the rail unions log history with live connections, so a connected-but-silent bot still appears", () => {
    const sources = toSources(toEpisodes(TURN), [connection(`slack`, `idle`)]);
    expect(sources.map(({ key, group, episodes, gateway }) => ({ key, group, episodes, gateway }))).toEqual([
        { key: DIRECT, group: `direct`, episodes: 1, gateway: undefined },
        { key: `slack`, group: `connections`, episodes: 0, gateway: `idle` },
    ]);
});

test("a provider whose bots disagree shows the worst state, not the healthiest", () => {
    const sources = toSources([], [connection(`discord`, `ready`, `bot-a`), connection(`discord`, `disconnected`, `bot-b`)]);
    expect(sources).toEqual([{ key: `discord`, group: `connections`, label: `Discord`, gateway: `disconnected`, episodes: 0, failed: 0 }]);
});

test("the rail counts failures per source and orders by most recent activity", () => {
    const events = [
        event({ id: `b1`, at: at(8), direction: `system`, type: `turn.error`, provider: `claude`, turnId: `bad`, outcome: `error`, error: `boom` }),
        event({ id: `g1`, at: at(1), direction: `in`, type: `message.received`, provider: `discord`, content: `hi` }),
    ];
    expect(toSources(toEpisodes(events), []).map(({ key, episodes, failed }) => ({ key, episodes, failed }))).toEqual([
        { key: DIRECT, episodes: 1, failed: 1 },
        { key: `discord`, episodes: 1, failed: 0 },
    ]);
});

test("search reaches the ids a row hides, not just the text it shows", () => {
    const [episode] = toEpisodes(TURN);
    expect(matches(episode as never, `redesign`)).toBe(true);
    expect(matches(episode as never, `s1`)).toBe(true);
    expect(matches(episode as never, ``)).toBe(true);
    expect(matches(episode as never, `nothing here`)).toBe(false);
});

/* The window vocabulary itself now lives in the kit (@intentic-app/ui/timeWindow) — Logs asks the same question
 * of its file list. The assertion stays here because this is the package whose feed depends on the answer, and
 * because _libs/ui has no test runner of its own. `all` is the case worth holding onto: it is the only preset
 * whose answer is not arithmetic, and -Infinity is what makes it correct for an entry a clock skew has put in
 * the future, where `now - <a century>` is merely large enough to get away with it. */
test("the window presets bound the feed and `all` does not", () => {
    expect(sinceOf(`1h`, at(0))).toBe(at(-60));
    expect(sinceOf(`24h`, at(0))).toBe(at(-60 * 24));
    expect(sinceOf(`7d`, at(0))).toBe(at(-60 * 24 * 7));
    expect(sinceOf(`all`, at(0))).toBe(-Infinity);
    expect(withinWindow(at(5), `all`, at(0))).toBe(true);
    expect(withinWindow(at(-90), `1h`, at(0))).toBe(false);
});

test("day dividers name the two days that carry the traffic and date the rest", () => {
    const now = at(0);
    const days = byDay(
        [
            { at: now, key: `a` },
            { at: now - 86_400_000, key: `b` },
            { at: now - 86_400_000 - 60_000, key: `c` },
            { at: now - 86_400_000 * 5, key: `d` },
        ] as never,
        now,
    );
    expect(days.map(({ label, episodes }) => [label, episodes.length])).toEqual([
        [`Today`, 1],
        [`Yesterday`, 2],
        [new Date(now - 86_400_000 * 5).toLocaleDateString(undefined, { month: `short`, day: `numeric` }), 1],
    ]);
});
