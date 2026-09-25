import type { MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { FEATURED_AGENT_ID, LAND_FIX_AGENT_ID } from "./fleet";

// The main tree's own check after work lands (GET /workspace/mainline), one state per recording. The whole fleet carries
// the story the strip exists for: the release notes' land turned `web` red, the conversation that landed it had gone
// cold, so a fresh one was started on it (fleet.ts), while the checkout run's latest land waits for the next check. The
// curated board has that check running; the minimal one, which the marketing shots are taken of, the all-clear. A desk
// has no code to check, so it has no main line at all. Times are relative to page load, like the roster's.

const minutes = (count: number): number => count * 60_000;

const RELEASE_NOTES = { conversationId: `cnv_release_notes`, title: `Draft the release notes for 2.4` };
const DEP_AUDIT = { conversationId: `cnv_dep_audit`, title: `Nightly dependency audit, 3 advisories, 2 patched` };
const CHECKOUT = { conversationId: FEATURED_AGENT_ID, title: `Add Stripe checkout to the pricing page` };

const WEB_RED = (now: number): MainlineRun => ({
    project: `web`,
    command: `pnpm verify`,
    status: `red`,
    startedAt: now - minutes(33),
    at: now - minutes(31),
    lands: [{ ...RELEASE_NOTES, at: now - minutes(34) }],
    failures: [
        `web/src/pages/changelog.test.ts › lists every release under its own heading`,
        `web/src/pages/changelog.test.ts › links each release to its tag`,
        `web typecheck: src/pages/changelog.ts(41,7): Property 'tag' does not exist on type 'Release'`,
    ],
    failureCount: 3,
    attempt: 1,
    suspects: [RELEASE_NOTES.conversationId],
    routing: {
        kind: `fix-up`,
        conversationId: LAND_FIX_AGENT_ID,
        at: now - minutes(30),
        detail: `The conversation that landed it ("${RELEASE_NOTES.title}") has gone cold or is nearly full, so reading all of it again would cost more than starting fresh.`,
    },
});

const API_GREEN = (now: number): MainlineRun => ({
    project: `api`,
    command: `pnpm test`,
    status: `green`,
    startedAt: now - minutes(391),
    at: now - minutes(388),
    lands: [{ ...DEP_AUDIT, at: now - minutes(392) }],
    failures: [],
    failureCount: 0,
    attempt: 0,
});

// The sandbox checking `web` again on its own, before the day's lands: a run no land asked for.
const WEB_RECHECK = (now: number): MainlineRun => ({
    project: `web`,
    command: `pnpm verify`,
    status: `green`,
    startedAt: now - minutes(424),
    at: now - minutes(420),
    lands: [],
    failures: [],
    failureCount: 0,
    attempt: 0,
});

const redLine = (now: number): MainlineStatus => {
    const red = WEB_RED(now);
    const api = API_GREEN(now);
    return {
        projects: [
            { project: `api`, queued: [], last: api },
            { project: `web`, queued: [{ ...CHECKOUT, at: now - 40_000 }], last: red, redSince: red.at },
        ],
        recent: [red, api, WEB_RECHECK(now)],
    };
};

// The checkout run's previous turn landed and passed; it is on its next one now.
const WEB_GREEN = (now: number): MainlineRun => ({
    project: `web`,
    command: `pnpm verify`,
    status: `green`,
    startedAt: now - minutes(15),
    at: now - minutes(12),
    lands: [{ ...CHECKOUT, at: now - minutes(16) }],
    failures: [],
    failureCount: 0,
    attempt: 0,
});

const greenLine = (now: number): MainlineStatus => {
    const green = WEB_GREEN(now);
    return { projects: [{ project: `web`, queued: [], last: green }], recent: [green, WEB_RECHECK(now)] };
};

// The checkout run landed its last turn a moment before the page opened, and `web`'s check is measuring it now.
const checkingLine = (now: number): MainlineStatus => {
    const green = WEB_GREEN(now);
    return {
        projects: [
            {
                project: `web`,
                running: { command: `pnpm verify`, startedAt: now - 25_000, lands: [{ ...CHECKOUT, at: now - 30_000 }] },
                queued: [],
                last: green,
            },
        ],
        recent: [green, WEB_RECHECK(now)],
    };
};

export type DemoMainline = `red` | `checking` | `green` | `none`;

export const demoMainline = (now: number, story: DemoMainline): MainlineStatus => {
    if (story === `none`) {
        return { projects: [], recent: [] };
    }
    return story === `red` ? redLine(now) : story === `checking` ? checkingLine(now) : greenLine(now);
};
