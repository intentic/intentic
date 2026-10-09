import type { WorkspaceHealth, WorkspaceHotspot, WorkspaceKeyModule } from "@intentic/sandbox-contract";

// What the Health tab reads for the shop's repositories: the resident index's hotspots (churn × branch points) and its
// key modules (PageRank over imports). The figures are shaped to show every posture a row can take: a file both churning
// and tangled, one tangled but quiet for a season (dimmed), one crowded rather than tangled, a test file, and a key
// module whose export surface is out of proportion to its peers. `score` is commits × branch points, as the engine ranks.

const DAY = 86_400_000;

// [path, commits, branch points, days since its latest commit]
type Spot = readonly [path: string, commits: number, complexity: number, daysAgo: number];

const WEB_SPOTS: readonly Spot[] = [
    [`src/pricing/CheckoutPanel.tsx`, 34, 41, 0.1],
    [`src/cart/useCart.ts`, 27, 33, 1],
    [`src/pricing/PricingPage.tsx`, 21, 18, 3],
    [`src/lib/api.ts`, 12, 29, 6],
    [`src/legacy/couponEngine.ts`, 4, 74, 210],
    [`src/routes/account/Orders.tsx`, 16, 17, 2],
    [`tests/signup.spec.ts`, 9, 26, 2],
    [`src/i18n/messages.ts`, 31, 6, 1],
    [`src/components/ProductGrid.tsx`, 11, 15, 9],
    [`src/lib/analytics.ts`, 7, 19, 14],
    [`src/routes/Search.tsx`, 8, 14, 20],
    [`src/lib/format.ts`, 10, 9, 5],
];

const WEB_MODULES: readonly WorkspaceKeyModule[] = [
    { path: `src/lib/api.ts`, exports: 14 },
    { path: `src/design/tokens.ts`, exports: 96 },
    { path: `src/lib/money.ts`, exports: 9 },
    { path: `src/cart/useCart.ts`, exports: 4 },
    { path: `src/lib/env.ts`, exports: 6 },
    { path: `src/routes/index.tsx`, exports: 3 },
    { path: `src/i18n/index.ts`, exports: 5 },
    { path: `src/lib/http.ts`, exports: 11 },
];

const API_SPOTS: readonly Spot[] = [
    [`src/routes/checkout.ts`, 16, 14, 0.2],
    [`src/db/schema.ts`, 11, 9, 1],
    [`src/billing/webhooks.ts`, 6, 22, 12],
    [`src/routes/users.ts`, 9, 8, 4],
];

const API_MODULES: readonly WorkspaceKeyModule[] = [
    { path: `src/db/migrations.ts`, exports: 3 },
    { path: `src/db/schema.ts`, exports: 18 },
    { path: `src/routes/index.ts`, exports: 2 },
];

const hotspots = (spots: readonly Spot[], now: number): WorkspaceHotspot[] =>
    spots
        .map(([path, commits, complexity, daysAgo]) => ({
            path,
            commits,
            // Lines moved scale with the commits that moved them; the panel plots neither, the agent's prompt quotes both.
            adds: commits * 23,
            dels: commits * 9,
            complexity,
            score: commits * complexity,
            latestMs: now - daysAgo * DAY,
        }))
        .toSorted((left, right) => right.score - left.score);

// The window narrows churn, never branch points: a file's last commit outside it drops it from the ranking.
const SINCE_DAYS: Readonly<Record<string, number>> = { "7d": 7, "30d": 30, "90d": 90 };

const report = (repo: string, spots: readonly Spot[], modules: readonly WorkspaceKeyModule[], since: string | undefined, now: number): WorkspaceHealth => {
    const days = since === undefined ? undefined : SINCE_DAYS[since];
    const inWindow = days === undefined ? spots : spots.filter(([, , , daysAgo]) => daysAgo <= days);
    const ranked = hotspots(inWindow, now);
    const files = repo === `api` ? 18 : 41;
    return {
        repo,
        totals: {
            files,
            symbols: repo === `api` ? 142 : 318,
            complexity: spots.reduce((sum, [, , complexity]) => sum + complexity, 0) + files * 2,
            hotspots: ranked.length,
        },
        hotspots: ranked,
        modules: [...modules],
        freshness: { state: `fresh` },
    };
};

export const demoHealth = (repo: string, since: string | undefined, now: number): WorkspaceHealth =>
    repo === `api` ? report(repo, API_SPOTS, API_MODULES, since, now) : report(repo, WEB_SPOTS, WEB_MODULES, since, now);
