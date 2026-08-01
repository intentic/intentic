import type {
    AgentChanges,
    AgentRepoChanges,
    FileDiff,
    GitChanges,
    LandConflict,
    LandResult,
    RepoChanges,
    SessionSummary,
    WorkspaceSearchGroup,
    WorkspaceSearchResult,
    WorkspaceSearchSpan,
    WorkspaceTree,
} from "@intentic/sandbox-contract";
import { CONFLICT_AGENT_ID, FEATURED_AGENT_ID, REVIEW_AGENT_ID } from "./fleet";

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

/* What is dirty in the main tree BEFORE anything lands: the checkout agent's first pass, already applied, plus
 * one file the owner is editing by hand.
 *
 * Paths here are REPO-relative, which is the one thing about this shape that is easy to get wrong: the panel
 * composes `repo` and `path` itself, so a root-relative path renders as `api/api/src/db/schema.ts`. Tool-call
 * locations and the workspace tree are the opposite — root-relative — because they address the whole /work drop.
 *
 * `origins` is per repo and maps a path to the agents that landed it; `originAgents` (once, on the response)
 * says who those ids ARE. Both halves or neither: an id in one and not the other is an unattributed chip. */
const BASE_CHANGES: RepoChanges[] = [
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
        origins: {
            "src/lib/checkout.ts": [FEATURED_AGENT_ID],
            "src/pricing/CheckoutPanel.tsx": [FEATURED_AGENT_ID],
            "tests/checkout.spec.ts": [FEATURED_AGENT_ID],
        },
    },
    {
        repo: `api`,
        branch: `main`,
        conflicted: [],
        staged: [],
        unstaged: [
            { path: `src/routes/checkout.ts`, status: `added`, additions: 38, deletions: 0 },
            // Nobody's but the owner's — which is what makes the auth agent's land refuse on it below.
            { path: `src/db/schema.ts`, status: `modified`, additions: 12, deletions: 2 },
        ],
        origins: { "src/routes/checkout.ts": [FEATURED_AGENT_ID] },
    },
];

const ORIGIN_AGENTS: Record<string, { title: string; provider: string }> = {
    [FEATURED_AGENT_ID]: { title: `Add Stripe checkout to the pricing page`, provider: `claude` },
    [REVIEW_AGENT_ID]: { title: `Migrate the users table to soft deletes`, provider: `claude` },
};

/* EVERY AGENT'S CUMULATIVE DELTA, which two surfaces read: the review panel (GET /agents/{id}/diff) and, once
 * it lands, the main tree's Changes panel. One table for both, because in the product they are one fact seen
 * from two sides — the whole point of "Land now" is watching a row cross from here to there. */
const AGENT_DELTAS: Record<string, AgentRepoChanges[]> = {
    [REVIEW_AGENT_ID]: [
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
    [CONFLICT_AGENT_ID]: [
        {
            repo: `api`,
            branch: `agent/auth-middleware`,
            changes: [
                { path: `src/middleware/session.ts`, status: `added`, additions: 148, deletions: 0, landed: false },
                { path: `src/server.ts`, status: `modified`, additions: 22, deletions: 31, landed: false },
                { path: `src/db/schema.ts`, status: `modified`, additions: 9, deletions: 4, landed: false },
            ],
        },
    ],
};

/* WHY THE AUTH AGENT'S LAND REFUSES, in the shape the daemon reports it — and with both halves of the report,
 * because they are what the panel's button ladder is built on: `diverged` is the agent's to rebase away (the
 * main line moved under it), `workspace` is the owner's own uncommitted edit on schema.ts above, which no
 * rebase can reach. A demo that only ever showed a clean land would be showing the easy half of landing. */
const CONFLICTS: Record<string, LandConflict[]> = {
    [CONFLICT_AGENT_ID]: [
        {
            repo: `api`,
            clean: 1,
            mainBranch: `main`,
            paths: [
                { path: `src/server.ts`, reason: `diverged` },
                { path: `src/db/schema.ts`, reason: `workspace` },
            ],
        },
    ],
};

// Which agents have landed. The one piece of state the land scenario turns on: it flips the review's rows and
// moves their files into the main tree, which is exactly what a land does.
const landedAgents = new Set<string>();

export const gitChanges = (): GitChanges => {
    // A copy per read: what a land adds belongs to `landedAgents`, not to the base the next read starts from.
    const repos = structuredClone(BASE_CHANGES);
    for (const agentId of landedAgents) {
        for (const delta of AGENT_DELTAS[agentId] ?? []) {
            const target = repos.find((repo) => repo.repo === delta.repo);
            if (target === undefined) {
                continue;
            }
            const origins = (target.origins ??= {});
            for (const change of delta.changes) {
                // A path the tree already carries keeps its row and gains an author: two agents can land the
                // same file, and the panel draws a chip per id.
                if (!target.unstaged.some((row) => row.path === change.path)) {
                    target.unstaged.push({ path: change.path, status: change.status, additions: change.additions, deletions: change.deletions });
                }
                origins[change.path] = [...(origins[change.path] ?? []), agentId];
            }
        }
    }
    return { repos, originAgents: ORIGIN_AGENTS };
};

/** The review panel's cumulative delta for one agent, plus why its last land refused. */
export const agentChanges = (agentId: string): AgentChanges => {
    const landed = landedAgents.has(agentId);
    const conflicts = CONFLICTS[agentId];
    const repos = structuredClone(AGENT_DELTAS[agentId] ?? []);
    for (const repo of repos) {
        for (const change of repo.changes) {
            change.landed = landed;
        }
    }
    return { repos, ...(conflicts === undefined ? {} : { conflicts }) };
};

/* LAND NOW. The recording's answer to the one press the fleet exists for: the agent's delta stops being a
 * proposal and becomes the tree's uncommitted work, attributed to it. An agent the fixture records a conflict
 * for refuses instead, exactly as the daemon does — nothing is applied, the worktree keeps everything, and the
 * report the panel renders is the same one that came back here. */
export const landAgentDelta = (agentId: string): LandResult => {
    const conflicts = CONFLICTS[agentId];
    if (conflicts !== undefined) {
        return { landed: false, conflicts };
    }
    landedAgents.add(agentId);
    return { landed: true };
};

/** Root-relative paths a land just wrote, for the `workspaceChanged` frame that refreshes every open panel. */
export const landedPaths = (agentId: string): string[] =>
    (AGENT_DELTAS[agentId] ?? []).flatMap((repo) => repo.changes.map((change) => `${repo.repo}/${change.path}`));

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

const USERS_ROUTE_BEFORE = `export const deleteUser = async (id: string) => {
    await db.delete(users).where(eq(users.id, id));
    return { ok: true };
};
`;

const USERS_ROUTE_AFTER = `export const deleteUser = async (id: string) => {
    // Retire, never remove: the row stays, every read filters it out (see liveUsers).
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));
    return { ok: true };
};
`;

// Keyed `<repo>/<repo-relative path>` — the two file-diff routes are addressed by that pair, and the join is
// what keeps `src/db/schema.ts` in two repos from being one entry.
const DIFFS: Record<string, FileDiff> = {
    "api/src/db/schema.ts": { before: SOFT_DELETE_BEFORE, after: SOFT_DELETE_AFTER },
    "api/src/routes/users.ts": { before: USERS_ROUTE_BEFORE, after: USERS_ROUTE_AFTER },
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

/* Content search over the files the recording carries — the fixture's answer to GET /workspace/search.
 *
 * It is a real text search, because that is what the panel's Text scope IS: one pattern (literal, or a regex
 * with .*), case-insensitive unless asked, every occurrence on a line reported as a span so the results mark
 * them. What the recording cannot do is the Smart scope's ranking, which needs an index of the reader's own
 * code — so Smart answers with the same matcher and says so in the note the panel renders. */
const filePaths = (): string[] => {
    const paths: string[] = [];
    // The recursive tree node erases to Record<string, unknown> in the contract's zod type; the fixture below
    // is the one that BUILT it, so its own shape is the authority here.
    const walk = (nodes: WorkspaceTree["tree"]): void => {
        for (const node of nodes) {
            if (node.type === `file`) {
                paths.push(node.path);
            } else if (node.children !== undefined) {
                walk(node.children as WorkspaceTree["tree"]);
            }
        }
    };
    walk(workspaceTree().tree);
    return paths;
};

// Fixed text unless the .* switch is on, and an unparseable regex falls back to matching itself — the same
// recovery the daemon's engine does, and the same note it reports for it.
const matcher = (query: string, options: SearchOptions): { regex: RegExp; note?: string } => {
    const escaped = query.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const flags = options.caseSensitive ? `g` : `gi`;
    const wrap = (source: string): string => (options.word ? String.raw`\b(?:${source})\b` : source);
    if (options.literal) {
        return { regex: new RegExp(wrap(escaped), flags) };
    }
    try {
        return { regex: new RegExp(wrap(query), flags) };
    } catch {
        return { regex: new RegExp(wrap(escaped), flags), note: `Pattern isn't a valid regular expression — searched for it as literal text.` };
    }
};

interface SearchOptions {
    readonly smart: boolean;
    readonly literal: boolean;
    readonly word: boolean;
    readonly caseSensitive: boolean;
}

export const searchWorkspace = (query: string, options: SearchOptions): WorkspaceSearchResult => {
    const { regex, note } = matcher(query, options);
    const groups: WorkspaceSearchGroup[] = [];
    let total = 0;
    for (const path of filePaths()) {
        const hits = fileBody(path)
            .split(`\n`)
            .map((text, index) => {
                regex.lastIndex = 0;
                const spans: WorkspaceSearchSpan[] = [...text.matchAll(regex)].map((match) => ({
                    start: match.index,
                    end: match.index + match[0].length,
                }));
                return { line: index + 1, text, spans, tags: [{ kind: `text` as const }] };
            })
            .filter((hit) => hit.spans.length > 0);
        if (hits.length > 0) {
            groups.push({ path, score: 1 / (groups.length + 1), hits });
            total += hits.length;
        }
    }
    const smartNote = `This recording answers Smart like Text — ranking by meaning needs your own sandbox's index.`;
    return {
        mode: options.smart ? `q` : `find`,
        total,
        files: groups.length,
        shown: total,
        groups,
        freshness: { state: `fresh`, ageMs: 0 },
        truncated: false,
        ...(options.smart ? { note: smartNote } : note !== undefined ? { note } : {}),
    };
};
