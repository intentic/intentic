import type { Finding, PushCheck, PushChecks, PushRecheckResult, Red } from "@intentic/sandbox-contract";

// WHAT A PUSH LEFT BEHIND (GET /workspace/push-checks), the case the Pipelines board's Left at push section is drawn
// from: two commits pushed to `web`'s main, and the pre-push hook, which never refuses, measuring an import cycle, a
// pricing chunk over its budget, a lockfile behind its manifest, lint the push added and a commit subject no later
// measurement can see fixed. A push just before it was refused by the repository's own hook, and a feature branch
// earlier in the day was clean. The findings are one set per page load: dismissing writes here and a reload brings them
// back, like every other write the demo holds. Times are relative to page load, like the roster's.

const minutes = (count: number): number => count * 60_000;

const PUSH_HEAD = `725e054fb6a1d3c8e0f94b27d5a6c1e8f3b2d094`;
const REFUSED_HEAD = `a41d0e2c7b95f3e8d1a06c4b2e7f9d5a3c8b1e60`;
const PUSH_BASE = `6c6a13a392d7e5b1f08c4a69e2d3b7f150a8c6e1`;
const PUSH_COMMIT = { sha: PUSH_HEAD, subject: `feat(pricing): show annual plans beside monthly` };

const finding = (id: string, over: Omit<Finding, "id" | "recheckable">): Finding => ({ id, recheckable: true, ...over });

const PUSH_FINDINGS: readonly Finding[] = [
    finding(`import-cycle:checkout-plans`, {
        source: `import-cycle`,
        gate: `code`,
        text: `- src/lib/checkout.ts -> src/pricing/plans.ts closes a cycle: imported at lib/checkout.ts:4; the way back is pricing/plans.ts:2 (import { planPrice } from "../lib/checkout")`,
        command: `pnpm -C web exec madge --circular src`,
        commit: PUSH_COMMIT,
    }),
    finding(`bundle-size:pricing`, {
        source: `bundle-size`,
        gate: `code`,
        text: `- src/pricing: the pricing chunk is 212 kB, the budget allows 180 kB`,
        command: `pnpm -C web size`,
        commit: PUSH_COMMIT,
    }),
    finding(`lockfile:stripe-js`, {
        source: `lockfile`,
        gate: `code`,
        text: `pnpm-lock.yaml is behind package.json: @stripe/stripe-js ^4.8.0 is not in the lockfile`,
        command: `pnpm install --lockfile-only`,
    }),
    finding(`eslint:CheckoutPanel.tsx:48`, {
        source: `eslint`,
        gate: `tidy`,
        text: `src/pricing/CheckoutPanel.tsx:48:7  'annualPriceId' is assigned a value but never used  no-unused-vars`,
        command: `pnpm -C web exec eslint src/pricing/CheckoutPanel.tsx`,
        commit: PUSH_COMMIT,
    }),
    finding(`eslint:checkout.ts:112`, {
        source: `eslint`,
        gate: `tidy`,
        text: `src/lib/checkout.ts:112:5  Empty block statement  no-empty`,
        command: `pnpm -C web exec eslint src/lib/checkout.ts`,
        commit: PUSH_COMMIT,
    }),
    finding(`silent-catch:api.ts:57`, {
        source: `silent-catch`,
        gate: `tidy`,
        text: `- src/lib/api.ts:57  .catch discards the error`,
        command: `node scripts/checks/silent-catch.mjs`,
        commit: PUSH_COMMIT,
    }),
    // About a commit already made: no measurement of the tree can see it gone, so it ends only when dismissed.
    {
        id: `commitlint:a41d0e2`,
        source: `commitlint`,
        text: `- a41d0e2 "annual plans wip": the subject must read type(scope): subject`,
        command: `pnpm exec commitlint --from ${PUSH_BASE.slice(0, 7)}`,
        recheckable: false,
    },
];

// What the repository's own hook said when it refused the push before: settled by the push that went, so owed by nobody.
const REFUSED_FINDING = finding(`pre-push:plans.test.ts`, {
    source: `pre-push`,
    text: `husky - pre-push hook exited with code 1: 2 failing tests in src/pricing/plans.test.ts`,
});

// Dismissed on this page, by finding id: the demo's own copy of what the daemon would file.
const dismissedPush = new Set<string>();

const pushesOf = (now: number): PushCheck[] => [
    {
        project: `web`,
        id: `push-725e054`,
        at: now - minutes(47),
        remote: `origin`,
        branch: `main`,
        base: PUSH_BASE,
        head: PUSH_HEAD,
        commits: 2,
        findings: [...PUSH_FINDINGS],
    },
    {
        project: `web`,
        id: `push-a41d0e2`,
        at: now - minutes(55),
        remote: `origin`,
        branch: `main`,
        base: PUSH_BASE,
        head: REFUSED_HEAD,
        commits: 1,
        findings: [REFUSED_FINDING],
        refused: true,
    },
    {
        project: `web`,
        id: `push-6c6a13a`,
        at: now - minutes(302),
        remote: `origin`,
        branch: `agent/bundle-budget`,
        head: PUSH_BASE,
        commits: 1,
        findings: [],
    },
];

// What the project owes of it, as the daemon files it: the push's findings, less what was dismissed on this page, each
// dismissal a decision on the red.
const pushRedsOf = (now: number): Red[] => {
    const owed = PUSH_FINDINGS.filter((each) => !dismissedPush.has(each.id));
    const decisions = dismissedPush.size === 0 ? [] : [{ kind: `dismissed` as const, at: now, findings: [...dismissedPush] }];
    return owed.length === 0 ? [] : [{ source: `push`, scope: `web`, since: now - minutes(47), findings: owed, decisions }];
};

// The two hands on it, as the daemon's routes answer them (workspace.pushDismiss / pushRecheck).
export const demoPushDismiss = ({
    ids,
    restore,
}: {
    readonly ids?: readonly string[] | undefined;
    readonly restore?: boolean | undefined;
}): { changed: number } => {
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
export const demoPushRecheck = (): PushRecheckResult => ({
    measured: true,
    resolved: 0,
    open: PUSH_FINDINGS.filter((each) => !dismissedPush.has(each.id)).length,
});

// The minimal recording is what the marketing shots are taken of, so it carries no push record, and a desk pushes
// nothing: both answer the empty record a sandbox that never pushed would.
export const demoPushChecks = (now: number, recorded: boolean): PushChecks =>
    recorded ? { pushed: pushesOf(now), reds: pushRedsOf(now) } : { pushed: [], reds: [] };
