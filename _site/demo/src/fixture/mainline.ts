import type { MainlinePush, MainlinePushRecheckResult, MainlineRun, MainlineStatus, PushFinding } from "@intentic/sandbox-contract";
import { FEATURED_AGENT_ID, LAND_FIX_AGENT_ID } from "./fleet";

// The main tree's own check after work lands (GET /workspace/mainline), one state per recording. The whole fleet carries
// the story the main line exists for: the release notes' land turned `web` red, the conversation that landed it had gone
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
    units: [
        { name: `lists every release under its own heading`, path: `web/src/pages/changelog.test.ts` },
        { name: `links each release to its tag`, path: `web/src/pages/changelog.test.ts` },
        { name: `web typecheck: src/pages/changelog.ts(41,7): Property 'tag' does not exist on type 'Release'`, path: `src/pages/changelog.ts(41,7)` },
    ],
    failureCount: 3,
    attempt: 1,
    suspects: [RELEASE_NOTES.conversationId],
    named: true,
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
            { project: `api`, queued: [], session: `panel-api--verify`, last: api },
            {
                project: `web`,
                queued: [{ ...CHECKOUT, at: now - 40_000 }],
                session: `panel-web--verify`,
                last: red,
                redSince: red.at,
                // As the sandbox laid it: the release notes' land, named by the paths it changed, and the fresh fix-up on it.
                red: { since: red.at, cause: [RELEASE_NOTES], named: true, ...(red.routing === undefined ? {} : { fixer: red.routing }) },
            },
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
    return { projects: [{ project: `web`, queued: [], session: `panel-web--verify`, last: green }], recent: [green, WEB_RECHECK(now)] };
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
                session: `panel-web--verify`,
                last: green,
            },
        ],
        recent: [green, WEB_RECHECK(now)],
    };
};

// WHAT A PUSH LEFT BEHIND, the real case the Main line's amber column was drawn from: two commits pushed to main, and
// the pre-push hook, which never refuses, measuring a cycle between two daemon modules, a spelled-out state dir, silent
// catches and folders over their size. An older push to a feature branch was clean. The findings are one set per page
// load: dismissing writes here and a reload brings them back, like every other write the demo holds.
const PUSH_HEAD = `725e054fb6a1d3c8e0f94b27d5a6c1e8f3b2d094`;
const PUSH_BASE = `6c6a13a392d7e5b1f08c4a69e2d3b7f150a8c6e1`;
const PUSH_COMMIT = { sha: PUSH_HEAD, subject: `fix(workspace): trash keeps what it moved until restored` };

const finding = (id: string, over: Omit<PushFinding, "id" | "state" | "kind"> & Partial<Pick<PushFinding, "kind">>): PushFinding => ({
    id,
    kind: `check`,
    state: `open`,
    ...over,
});

const PUSH_FINDINGS: readonly PushFinding[] = [
    finding(`daemon-boundaries:portability-settings`, {
        check: `daemon-boundaries`,
        gate: `code`,
        text: `- portability -> settings closes portability -> settings -> agent -> runners -> portability: imported at portability/definition.ts:18; the way back is settings -> agent (settings/field-notes-status.ts:4), agent -> runners (agent/routes/agent.routes.ts:53), runners -> portability (runners/runner-link.ts:6)`,
        command: `node _tools/checks/run.mjs --only daemon-boundaries`,
        commit: PUSH_COMMIT,
    }),
    finding(`paths:workspace-trash.integration.test.ts:8`, {
        check: `paths`,
        gate: `tidy`,
        text: `_sandbox/sandbox/src/workspace/files/workspace-trash.integration.test.ts:8  spells the state dir, import STATE_DIR from @intentic/constants (or use the daemon's statePath())`,
        command: `node _tools/checks/run.mjs --only paths`,
        commit: PUSH_COMMIT,
    }),
    finding(`silent-catch:workspace-trash.ts:127`, {
        check: `silent-catch`,
        gate: `tidy`,
        text: `- _sandbox/sandbox/src/workspace/files/workspace-trash.ts:127  .catch discards the error`,
        command: `node _tools/checks/run.mjs --only silent-catch`,
        commit: PUSH_COMMIT,
    }),
    finding(`silent-catch:workspace-trash.ts`, {
        check: `silent-catch`,
        gate: `tidy`,
        text: `- _sandbox/sandbox/src/workspace/files/workspace-trash.ts: 3 silent catch(es), the baseline allows 0`,
        command: `node _tools/checks/run.mjs --only silent-catch`,
        commit: PUSH_COMMIT,
    }),
    finding(`layout:features/workspace/explorer`, {
        check: `layout`,
        gate: `tidy`,
        text: `- _editor/web/src/features/workspace/explorer: 36 files, the baseline allows 33`,
        command: `node _tools/checks/run.mjs --only layout`,
    }),
    finding(`layout:workspace/files`, {
        check: `layout`,
        gate: `tidy`,
        text: `- _sandbox/sandbox/src/workspace/files: 32 files`,
        command: `node _tools/checks/run.mjs --only layout`,
        commit: PUSH_COMMIT,
    }),
    finding(`buttons:SandboxMetricsDetails.vue:29`, {
        check: `buttons`,
        gate: `tidy`,
        text: `_editor/web/src/features/agents/metrics/SandboxMetricsDetails.vue:29  a bare <button> with text size and padding: use <Button size="small">, ui.linkButton() or ui.textAction()`,
        command: `node _tools/checks/run.mjs --only buttons`,
    }),
];

// Dismissed on this page, by finding id: the demo's own copy of what the daemon would file.
const dismissedPush = new Set<string>();

const pushesOf = (now: number): MainlinePush[] => [
    {
        project: `intentic`,
        id: `push-725e054`,
        at: now - minutes(47),
        remote: `origin`,
        branch: `main`,
        base: PUSH_BASE,
        head: PUSH_HEAD,
        commits: 2,
        findings: PUSH_FINDINGS.map((each) => (dismissedPush.has(each.id) ? { ...each, state: `dismissed`, settledAt: now } : each)),
    },
    {
        project: `intentic`,
        id: `push-6c6a13a`,
        at: now - minutes(302),
        remote: `origin`,
        branch: `docs/verify-push`,
        head: PUSH_BASE,
        commits: 1,
        findings: [],
    },
];

// The two hands on it, as the daemon's routes answer them (workspace.mainlinePushDismiss / mainlinePushRecheck).
export const demoPushDismiss = ({ ids, restore }: { readonly ids?: readonly string[] | undefined; readonly restore?: boolean | undefined }): { changed: number } => {
    const named = ids ?? PUSH_FINDINGS.map((each) => each.id);
    // Only what actually moves counts, the way the daemon answers: a finding already in the asked state is unchanged.
    const moving = named.filter((id) => dismissedPush.has(id) === (restore === true));
    for (const id of moving) {
        if (restore === true) {
            dismissedPush.delete(id);
        } else {
            dismissedPush.add(id);
        }
    }
    return { changed: moving.length };
};

// Nothing in the demo's tree changes, so a fresh measurement finds exactly what the last one did.
export const demoPushRecheck = (): MainlinePushRecheckResult => ({
    measured: true,
    resolved: 0,
    open: PUSH_FINDINGS.filter((each) => !dismissedPush.has(each.id)).length,
});

export type DemoMainline = `red` | `checking` | `green` | `none`;

// The minimal recording is what the marketing shots are taken of, so it carries no push record: its all-clear is the
// whole story there.
export const demoMainline = (now: number, story: DemoMainline): MainlineStatus => {
    if (story === `none`) {
        return { projects: [], recent: [] };
    }
    if (story === `green`) {
        return greenLine(now);
    }
    return { ...(story === `red` ? redLine(now) : checkingLine(now)), pushes: pushesOf(now) };
};
