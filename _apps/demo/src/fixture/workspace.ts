import type { AgentChanges, FileDiff, GitChanges, SessionSummary, WorkspaceTree } from "@intentic/sandbox-contract";
import { REVIEW_AGENT_ID } from "./fleet";

/* THE WORKSPACE the demo's sandbox holds: `acme-shop`, a two-repo product (a web front end and its API), with
 * a handful of dirty files so the Changes review has something to show and three agents' names to attribute
 * them to. Small on purpose — a tree with 4,000 nodes proves nothing a tree with forty doesn't. */

export const REPOS = [`web`, `api`] as const;

const file = (path: string, size: number): { name: string; path: string; type: "file"; size: number } => ({
    name: path.split(`/`).at(-1) ?? path,
    path,
    type: `file`,
    size,
});

const dir = (path: string, children: WorkspaceTree["tree"]): { name: string; path: string; type: "dir"; children: WorkspaceTree["tree"] } => ({
    name: path.split(`/`).at(-1) ?? path,
    path,
    type: `dir`,
    children,
});

export const workspaceTree = (): WorkspaceTree => ({
    root: `/work`,
    hidden: 0,
    tree: [
        dir(`web`, [
            dir(`web/src`, [
                dir(`web/src/pricing`, [
                    file(`web/src/pricing/PricingPage.tsx`, 3_184),
                    file(`web/src/pricing/CheckoutPanel.tsx`, 2_240),
                    file(`web/src/pricing/plans.ts`, 812),
                ]),
                dir(`web/src/lib`, [file(`web/src/lib/checkout.ts`, 640), file(`web/src/lib/api.ts`, 1_120)]),
                file(`web/src/App.tsx`, 1_940),
                file(`web/src/main.tsx`, 420),
            ]),
            dir(`web/tests`, [file(`web/tests/checkout.spec.ts`, 1_460), file(`web/tests/signup.spec.ts`, 2_010)]),
            file(`web/package.json`, 780),
            file(`web/vite.config.ts`, 512),
            { ...dir(`web/node_modules`, []), children: undefined, ignored: true },
        ]),
        dir(`api`, [
            dir(`api/src`, [
                dir(`api/src/routes`, [file(`api/src/routes/checkout.ts`, 1_020), file(`api/src/routes/users.ts`, 2_460)]),
                dir(`api/src/db`, [file(`api/src/db/schema.ts`, 3_320), file(`api/src/db/migrations.ts`, 1_180)]),
                file(`api/src/stripe.ts`, 460),
                file(`api/src/server.ts`, 1_640),
            ]),
            file(`api/package.json`, 690),
        ]),
        file(`README.md`, 2_140),
    ],
});

/* The Changes review: what is dirty in the main tree right now, and which agent wrote it.
 *
 * Paths here are REPO-relative, which is the one thing about this shape that is easy to get wrong: the panel
 * composes `repo` and `path` itself, so a root-relative path renders as `api/api/src/db/schema.ts`. Tool-call
 * locations and the workspace tree are the opposite — root-relative — because they address the whole /work drop. */
export const gitChanges = (): GitChanges => ({
    repos: [
        {
            repo: `web`,
            branch: `main`,
            conflicted: [],
            staged: [],
            unstaged: [
                { path: `src/lib/checkout.ts`, status: `modified`, additions: 6, deletions: 3 },
                { path: `src/pricing/CheckoutPanel.tsx`, status: `modified`, additions: 28, deletions: 4 },
                { path: `tests/checkout.spec.ts`, status: `added`, additions: 44, deletions: 0 },
            ],
        },
        {
            repo: `api`,
            branch: `main`,
            conflicted: [],
            staged: [],
            unstaged: [
                { path: `src/routes/checkout.ts`, status: `added`, additions: 38, deletions: 0 },
                { path: `src/db/schema.ts`, status: `modified`, additions: 12, deletions: 2 },
            ],
        },
    ],
    originAgents: {
        cnv_release_notes: { title: `Draft the release notes for 2.4`, provider: `claude` },
    },
});

/** The review panel's cumulative delta for the agent holding work on its branch. */
export const agentChanges = (agentId: string): AgentChanges =>
    agentId === REVIEW_AGENT_ID
        ? {
              repos: [
                  {
                      repo: `api`,
                      branch: `agent/soft-deletes`,
                      changes: [
                          { path: `src/db/schema.ts`, status: `modified`, additions: 34, deletions: 8, landed: false },
                          { path: `src/db/migrations.ts`, status: `modified`, additions: 62, deletions: 0, landed: false },
                          { path: `src/routes/users.ts`, status: `modified`, additions: 96, deletions: 41, landed: false },
                      ],
                  },
                  {
                      repo: `web`,
                      branch: `agent/soft-deletes`,
                      changes: [{ path: `src/lib/api.ts`, status: `modified`, additions: 18, deletions: 6, landed: false }],
                  },
              ],
          }
        : { repos: [] };

const SOFT_DELETE_BEFORE = `export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
});
`;

const SOFT_DELETE_AFTER = `export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Soft delete: rows are retired, never removed — every read filters on this.
    deletedAt: timestamp("deleted_at"),
});

export const liveUsers = () => db.select().from(users).where(isNull(users.deletedAt));
`;

const CHECKOUT_LIB_BEFORE = `export const checkout = async (priceId: string) => {
    throw new Error("NotImplemented");
};
`;

const CHECKOUT_LIB_AFTER = `export const checkout = async (priceId: string) => {
    const response = await api.post("/checkout/session", { priceId });
    window.location.assign(response.url);
};
`;

// Keyed `<repo>/<repo-relative path>` — the two file-diff routes are addressed by that pair, and the join is
// what keeps `src/db/schema.ts` in two repos from being one entry.
const DIFFS: Record<string, FileDiff> = {
    "api/src/db/schema.ts": { before: SOFT_DELETE_BEFORE, after: SOFT_DELETE_AFTER },
    "web/src/lib/checkout.ts": { before: CHECKOUT_LIB_BEFORE, after: CHECKOUT_LIB_AFTER },
};

/* A file the recording does not carry a diff for still has to open — a review panel whose rows go nowhere is
 * worse than one with fewer rows — so it says so in the file it opens, in place of pretending to a change. */
const UNRECORDED = `// The demo carries a few diffs in full; this file's is not one of them.\n`;

export const fileDiff = (repo: string, path: string): FileDiff => DIFFS[`${repo}/${path}`] ?? { before: UNRECORDED, after: UNRECORDED };

const README = `# acme-shop

A two-repo product: the storefront (\`web\`) and its API (\`api\`).

This workspace is a **recording**. Every panel around it is the real intentic UI, wired to a fixture
instead of a daemon — so you can open anything, but nothing here runs.

Start a sandbox on your own machine and the same surfaces point at your repos.
`;

export const fileBody = (path: string): string =>
    path === `README.md`
        ? README
        : path === `web/src/lib/checkout.ts`
          ? CHECKOUT_LIB_AFTER
          : path === `api/src/db/schema.ts`
            ? SOFT_DELETE_AFTER
            : `// ${path}\n//\n// The demo carries a few files in full; this one is listed but not recorded.\n`;

/* The sessions window: the conversations this sandbox has had. More than the fleet board shows, because the
 * board is today's work and this is the whole history — which is the distinction the window exists to make. */
export const sessions = (now: number): SessionSummary[] => {
    const hour = 3_600_000;
    return [
        { id: `ses_01j9checkout`, title: `Add Stripe checkout to the pricing page`, updatedAt: now - 90_000 },
        { id: `ses_01j9flaky`, title: `Fix the flaky signup e2e test`, updatedAt: now - 2 * 60_000 },
        { id: `ses_01j9auth`, title: `Refactor the auth middleware onto the new session store`, updatedAt: now - 11 * 60_000 },
        { id: `ses_01j9latency`, title: `Investigate the p99 latency spike on /checkout`, updatedAt: now - 60_000 },
        { id: `ses_01j9soft`, title: `Migrate the users table to soft deletes`, updatedAt: now - 18 * 60_000 },
        { id: `ses_01j9notes`, title: `Draft the release notes for 2.4`, updatedAt: now - 34 * 60_000 },
        { id: `ses_01j9audit`, title: `Nightly dependency audit — 3 advisories, 2 patched`, updatedAt: now - 7 * hour },
        { id: `ses_01j9seo`, title: `Add structured data to the product pages`, updatedAt: now - 26 * hour },
        { id: `ses_01j9emails`, title: `Move transactional emails to the queue`, updatedAt: now - 2 * 24 * hour },
        { id: `ses_01j9upgrade`, title: `Upgrade to Vite 8 and drop the CJS shims`, updatedAt: now - 3 * 24 * hour },
        { id: `ses_01j9a11y`, title: `Fix the keyboard trap in the plan switcher`, updatedAt: now - 4 * 24 * hour },
        { id: `ses_01j9docs`, title: `Document the checkout webhook contract`, updatedAt: now - 6 * 24 * hour },
    ];
};
