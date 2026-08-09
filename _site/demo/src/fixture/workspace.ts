import type {
    AgentChanges,
    AgentRepoChanges,
    FileDiff,
    GitChanges,
    LandConflict,
    LandResult,
    RepoChanges,
    SessionSummary,
    WorkspaceChildren,
    WorkspaceSearchGroup,
    WorkspaceSearchResult,
    WorkspaceSearchSpan,
    WorkspaceTree,
} from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { includeGlobs } from "@intentic/sandbox-contract";
import { acceptanceFiles } from "./acceptance";
import { choreFiles } from "./chores";
import { documentationFiles } from "./docs";
import { CONFLICT_AGENT_ID, REVIEW_AGENT_ID } from "./fleet";

/* THE WORKSPACE the demo's sandbox holds: `acme-shop`, a two-repo product (a web front end and its API), with
 * a handful of dirty files so the Changes review has something to show and three agents' names to attribute
 * them to. Small on purpose — a tree with 4,000 nodes proves nothing a tree with forty doesn't. */

export const REPOS = [`web`, `api`] as const;

/* What is dirty in the main tree BEFORE anything lands: the checkout agent's first pass, already applied, plus
 * one file the owner is editing by hand.
 *
 * Paths here are REPO-relative, which is the one thing about this shape that is easy to get wrong: the panel
 * composes `repo` and `path` itself, so a root-relative path renders as `api/api/src/db/schema.ts`. Tool-call
 * locations and the workspace tree are the opposite — root-relative — because they address the whole /work drop.
 *
 * `origins` is per repo and maps a path to the agents that landed it; `originAgents` (once, on the response)
 * says who those ids ARE. Both halves or neither: an id in one and not the other is an unattributed chip.
 *
 * NOTHING HERE IS ATTRIBUTED, and that is the point of the demo's Land: what is dirty before a visitor presses
 * anything is the owner's own uncommitted work, so the panel's legend reads "you 5" and no row carries a chip.
 * Press Land now and the soft-deletes agent's files arrive WITH one — the contrast is what makes attribution
 * legible, where a tree that was already covered in chips only made it wallpaper. */
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
    },
    {
        repo: `api`,
        branch: `main`,
        conflicted: [],
        staged: [],
        unstaged: [
            { path: `src/routes/checkout.ts`, status: `added`, additions: 38, deletions: 0 },
            // The owner's own edit — which is what makes the auth agent's land refuse on it below.
            { path: `src/db/schema.ts`, status: `modified`, additions: 12, deletions: 2 },
        ],
    },
];

const ORIGIN_AGENTS: Record<string, { title: string; provider: string }> = {
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

/* THE CHECKOUT STORY, in full. These four are the files the featured run works on, so they are the ones a
 * visitor is most likely to open a diff for — the chat names each of them while it writes them, and the Changes
 * panel then has to show the same edit the transcript just described. turn.ts reads the same constants, so the
 * tool card and the diff row cannot drift apart. */
export const CHECKOUT_LIB_BEFORE = `export const checkout = async (priceId: string) => {
    throw new Error("NotImplemented");
};
`;

export const CHECKOUT_LIB_AFTER = `export const checkout = async (priceId: string) => {
    const response = await api.post("/checkout/session", { priceId });
    window.location.assign(response.url);
};
`;

// The endpoint the run writes first, and the only file in the story that is created rather than edited.
export const CHECKOUT_ROUTE = `import { stripe } from "../stripe";

export const createCheckoutSession = async (req: Request, res: Response) => {
    const { priceId } = checkoutBody.parse(req.body);
    const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: \`\${env.WEB_ORIGIN}/welcome?session={CHECKOUT_SESSION_ID}\`,
        cancel_url: \`\${env.WEB_ORIGIN}/pricing\`,
    });
    res.json({ url: session.url });
};
`;

const CHECKOUT_PANEL_BEFORE = `import { checkout } from "../lib/checkout";
import type { Plan } from "./plans";

export const CheckoutPanel = ({ plan }: { plan: Plan }) => {
    const start = () => {
        checkout(plan.priceId);
    };

    return (
        <div className="panel">
            <h3>{plan.name}</h3>
            <p className="price">{plan.amount}</p>
            <button type="button" className="cta" onClick={start}>
                Start with {plan.name}
            </button>
        </div>
    );
};
`;

/* The last edit of the run, and the one the visitor's own answer decides: the question card asks what the CTA
 * should do while the redirect is in flight, and "inline spinner" is the recommended option it comes back with. */
const CHECKOUT_PANEL_AFTER = `import { useState } from "react";
import { Spinner } from "../common/Spinner";
import { checkout } from "../lib/checkout";
import type { Plan } from "./plans";

// Stripe takes a moment to answer, and a CTA that still looks idle while it does is one people press twice — so
// the button owns the whole redirect: pending, failed, and the way back out of a failure.
type Status = "idle" | "pending" | "failed";

export const CheckoutPanel = ({ plan }: { plan: Plan }) => {
    const [status, setStatus] = useState<Status>("idle");

    const start = async () => {
        setStatus("pending");
        try {
            await checkout(plan.priceId);
        } catch {
            // The redirect never happened, so this page is still here to say so.
            setStatus("failed");
        }
    };

    return (
        <div className="panel">
            <h3>{plan.name}</h3>
            <p className="price">{plan.amount}</p>
            <button type="button" className="cta" onClick={start} disabled={status === "pending"}>
                {status === "pending" ? <Spinner label="Redirecting…" /> : \`Start with \${plan.name}\`}
            </button>
            {status === "failed" && (
                <p className="cta-error" role="alert">
                    Couldn't reach checkout.{" "}
                    <button type="button" className="link" onClick={start}>
                        Try again
                    </button>
                </p>
            )}
        </div>
    );
};
`;

// The three the run's last todo covers — the redirect, the failure path, and the button that must not be
// pressable twice. Their names are what the terminal prints when the run's \`pnpm test\` goes green.
const CHECKOUT_SPEC = `import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { checkout } from "../src/lib/checkout";
import { CheckoutPanel } from "../src/pricing/CheckoutPanel";

vi.mock("../src/lib/checkout", () => ({ checkout: vi.fn() }));

const growth: Plan = { name: "Growth", amount: "$29", priceId: "price_growth" };

test("pressing the CTA opens a checkout session for that plan's price", async () => {
    vi.mocked(checkout).mockResolvedValue();
    render(<CheckoutPanel plan={growth} />);

    await userEvent.click(screen.getByRole("button", { name: /start with growth/i }));

    expect(checkout).toHaveBeenCalledWith("price_growth");
});

test("the CTA cannot be pressed twice while the redirect is in flight", async () => {
    vi.mocked(checkout).mockReturnValue(new Promise(() => {}));
    render(<CheckoutPanel plan={growth} />);

    const cta = screen.getByRole("button", { name: /start with growth/i });
    await userEvent.click(cta);

    expect(cta).toBeDisabled();
    expect(screen.getByText("Redirecting…")).toBeVisible();
});

test("a session that never opens leaves the page with a way to retry", async () => {
    vi.mocked(checkout).mockRejectedValue(new Error("stripe unreachable"));
    render(<CheckoutPanel plan={growth} />);

    await userEvent.click(screen.getByRole("button", { name: /start with growth/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach checkout");
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
});
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
// A file the tree ADDED has no before side, exactly as the daemon reports it — the left pane is empty and the
// whole file reads as an addition.
const DIFFS: Record<string, FileDiff> = {
    "api/src/db/schema.ts": { before: SOFT_DELETE_BEFORE, after: SOFT_DELETE_AFTER },
    "api/src/routes/users.ts": { before: USERS_ROUTE_BEFORE, after: USERS_ROUTE_AFTER },
    "api/src/routes/checkout.ts": { after: CHECKOUT_ROUTE },
    "web/src/lib/checkout.ts": { before: CHECKOUT_LIB_BEFORE, after: CHECKOUT_LIB_AFTER },
    "web/src/pricing/CheckoutPanel.tsx": { before: CHECKOUT_PANEL_BEFORE, after: CHECKOUT_PANEL_AFTER },
    "web/tests/checkout.spec.ts": { after: CHECKOUT_SPEC },
};

/* A file the recording does not carry a diff for still has to open — a review panel whose rows go nowhere is
 * worse than one with fewer rows — so it says so in the file it opens, in place of pretending to a change.
 *
 * It says so as an ADDITION, and in prose, because both halves of that are what make it visible at all. A note
 * carried identically on BOTH sides is not a change, so the diff has nothing to render; and a note written as a
 * COMMENT is taken back out by the reading setting that strips comments before the diff is computed. Either one
 * alone leaves the reader looking at two empty panes with nothing to explain them. */
const UNRECORDED = `This file's diff is not one of the few the demo carries in full.

Open web/src/lib/checkout.ts or api/src/db/schema.ts to read one it does.
`;

export const fileDiff = (repo: string, path: string): FileDiff => DIFFS[`${repo}/${path}`] ?? { after: UNRECORDED };

const README = `# acme-shop

A two-repo product: the storefront (\`web\`) and its API (\`api\`).

This workspace is a **recording**. Every panel around it is the real intentic UI, wired to a fixture
instead of a daemon — so you can open anything, but nothing here runs.

Start a sandbox on your own machine and the same surfaces point at your repos.
`;

/* ---- THE RECORDING'S FILESYSTEM ------------------------------------------------------------------------------
 *
 * One flat table, root-relative, and the only place a demo file is declared. The tree, every directory listing,
 * every read, the content search and every write derive from it — so a file added here appears in all five with
 * nothing else to keep in step.
 *
 * A STRING is the file's body. A NUMBER is a file the tree lists but the recording does not carry: the size it
 * claims, with a body that says as much when it is opened. That distinction is what lets acme-shop look like a
 * checkout somebody works in — forty files, plausible sizes — while only the ones a visitor actually reads are
 * written out in full.
 *
 * A path that is NOT here answers 404, exactly as the daemon does, and that matters more than it sounds: half
 * the surfaces above read a file to find out whether something exists at all (an acknowledgement, a staged
 * document set, a run's result), and a fixture that answered every read with a placeholder would tell all of
 * them yes.
 *
 * It is MUTABLE, because the surfaces that read it also write: acknowledging evidence in Maintenance, saving a
 * story in Acceptance, publishing a document set. A write lands here and every later read sees it — real until
 * the tab is reloaded, which is the promise the rest of this fixture makes too. */

/** Built once at page load, so a run recorded "42 minutes ago" is 42 minutes before the visitor arrived. */
const RECORDED_AT = Date.now();

const SOURCES: [string, string | number][] = [
    [`README.md`, README],

    // The storefront.
    [`web/src/pricing/PricingPage.tsx`, 3_184],
    [`web/src/pricing/CheckoutPanel.tsx`, CHECKOUT_PANEL_AFTER],
    [`web/src/pricing/plans.ts`, 812],
    [`web/src/lib/checkout.ts`, CHECKOUT_LIB_AFTER],
    [`web/src/lib/api.ts`, 1_120],
    [`web/src/App.tsx`, 1_940],
    [`web/src/main.tsx`, 420],
    [`web/tests/checkout.spec.ts`, CHECKOUT_SPEC],
    [`web/tests/signup.spec.ts`, 2_010],
    [`web/.github/workflows/ci.yml`, 1_240],
    [`web/package.json`, 780],
    [`web/pnpm-lock.yaml`, 184_600],
    [`web/vite.config.ts`, 512],
    // Ignored, so the tree lists it grayed and never descends: expanding it is what /workspace/children is for.
    [`web/node_modules/react/package.json`, 3_120],
    [`web/node_modules/vite/package.json`, 4_040],

    // The API.
    [`api/src/routes/checkout.ts`, CHECKOUT_ROUTE],
    [`api/src/routes/users.ts`, 2_460],
    [`api/src/db/schema.ts`, SOFT_DELETE_AFTER],
    [`api/src/db/migrations.ts`, 1_180],
    [`api/src/stripe.ts`, 460],
    [`api/src/server.ts`, 1_640],
    [`api/.github/workflows/api.yml`, 980],
    [`api/Dockerfile`, 640],
    [`api/package.json`, 690],
    [`api/pnpm-lock.yaml`, 96_200],
];

const FILES = new Map<string, string | number>([
    ...SOURCES,
    ...acceptanceFiles(RECORDED_AT),
    ...documentationFiles(RECORDED_AT),
    ...choreFiles(RECORDED_AT),
]);

// What the daemon's ignore scope grays and does not walk into (workspace-ignore's own shortlist). The recording
// carries node_modules because a tree without one reads like a checkout nobody has installed.
const IGNORED_DIRS = new Set([`node_modules`, `.git`, `dist`, `.turbo`, `.cache`]);

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentOf = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);
const sizeOf = (entry: string | number): number => (typeof entry === `number` ? entry : entry.length);
const isIgnored = (path: string): boolean => path.split(`/`).some((segment) => IGNORED_DIRS.has(segment));

// One entry while the walk is still building it. Structurally a WorkspaceTreeEntry with a mutable `children`,
// because folding a flat table into a tree means pushing into that array — and the contract's entry is readonly
// all the way down, which is right for everyone who only reads it.
interface TreeNode {
    name: string;
    path: string;
    type: "file" | "dir";
    size?: number;
    ignored?: boolean;
    children?: TreeNode[];
}

// Directories first, then by name — the order every file tree is read in, and the one the daemon's walk returns.
const ordered = (entries: TreeNode[]): TreeNode[] =>
    entries.toSorted((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === `dir` ? -1 : 1));

/* The nested tree `GET /workspace/tree` answers with. An ignored directory is LISTED but carries no `children`,
 * which is the contract's way of saying "not descended into" — the client then lazy-loads it on expand, and the
 * two states (not loaded yet / genuinely empty) stay distinguishable. */
export const workspaceTree = (): WorkspaceTree => {
    const roots: TreeNode[] = [];
    const folders = new Map<string, TreeNode>();
    // The array a path's children go in — undefined when an ancestor is ignored, and therefore never descended.
    const childrenAt = (path: string): TreeNode[] | undefined => {
        if (path === ``) {
            return roots;
        }
        const known = folders.get(path);
        if (known !== undefined) {
            return known.children;
        }
        const siblings = childrenAt(parentOf(path));
        if (siblings === undefined) {
            return undefined;
        }
        const name = nameOf(path);
        const folder: TreeNode = IGNORED_DIRS.has(name) ? { name, path, type: `dir`, ignored: true } : { name, path, type: `dir`, children: [] };
        folders.set(path, folder);
        siblings.push(folder);
        return folder.children;
    };
    for (const [path, entry] of FILES) {
        childrenAt(parentOf(path))?.push({ name: nameOf(path), path, type: `file`, size: sizeOf(entry) });
    }
    for (const folder of folders.values()) {
        folder.children = folder.children === undefined ? undefined : ordered(folder.children);
    }
    return { root: WORKSPACE_ROOT, hidden: 0, tree: ordered(roots) };
};

/** One directory's immediate children — the lazy-load behind an ignored dir, and how every extension walks. */
export const workspaceChildren = (path: string): WorkspaceChildren => {
    const prefix = `${path}/`;
    const entries = new Map<string, TreeNode>();
    const inIgnored = isIgnored(path);
    for (const [candidate, entry] of FILES) {
        if (!candidate.startsWith(prefix)) {
            continue;
        }
        const rest = candidate.slice(prefix.length);
        const name = rest.includes(`/`) ? rest.slice(0, rest.indexOf(`/`)) : rest;
        const child = `${path}/${name}`;
        entries.set(
            name,
            rest.includes(`/`)
                ? { name, path: child, type: `dir`, ...(inIgnored || IGNORED_DIRS.has(name) ? { ignored: true } : {}) }
                : { name, path: child, type: `file`, size: sizeOf(entry), ...(inIgnored ? { ignored: true } : {}) },
        );
    }
    return { entries: ordered([...entries.values()]), hidden: 0 };
};

// A file the tree lists but the recording does not carry says so in the file it opens: a viewer that shows an
// empty buffer reads as a broken app, and inventing 3kB of plausible React would be worse than either.
const unrecordedBody = (path: string): string => `// ${path}\n//\n// The demo carries a few files in full; this one is listed but not recorded.\n`;

export const fileBody = (path: string): string | undefined => {
    const entry = FILES.get(path);
    return entry === undefined ? undefined : typeof entry === `number` ? unrecordedBody(path) : entry;
};

/* GET /workspace/file — the whole file as one window, which is what every read in this recording is. A path the
 * recording does not carry answers `present: false`, exactly as the daemon does: half the surfaces here read a
 * file to find out whether something EXISTS, and that answer is not a failure. */
export const readFile = (
    path: string,
): { present: true; path: string; content: string; size: number; offset: number; bytes: number; shared: true } | { present: false; path: string } => {
    const content = fileBody(path);
    return content === undefined
        ? { present: false, path }
        : { present: true, path, content, size: content.length, offset: 0, bytes: content.length, shared: true };
};

/** POST /workspace/upload — the writes the panels make: an acknowledgement, a story, a published document. */
export const writeFile = (path: string, content: string): void => {
    FILES.set(path, content);
};

/** DELETE /workspace/entry — a file, or a directory and everything under it. */
export const deleteEntry = (path: string): void => {
    FILES.delete(path);
    for (const candidate of FILES.keys()) {
        if (candidate.startsWith(`${path}/`)) {
            FILES.delete(candidate);
        }
    }
};

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
// What there is to search: the files the recording carries a BODY for, ignored paths excluded — the same two
// rules the daemon's search follows (it cannot match text it does not have, and it skips node_modules by
// default), so a hit here is a hit a real workspace would also produce.
const searchablePaths = (include: string): string[] => {
    const admits = includeFilter(include);
    return [...FILES].flatMap(([path, entry]) => (typeof entry === `string` && !isIgnored(path) && admits(path) ? [path] : []));
};

/* The panel's second field, answered from the SAME reading of what was typed as the real daemon's: includeGlobs
 * (the contract) expands the field into path globs, and only the MATCHING of those globs is local here — for
 * the same reason the text matcher above is local, this fixture holds a few dozen paths and no search engine. */
// One glob token → one regex, everything else escaped as itself. A globstar before a slash spans whole
// directories and may span none (so `*.ts` finds a file at the root); at the end it is the rest of the path.
const GLOB_TOKENS: Record<string, string> = {
    "**/": `(?:[^/]+/)*`,
    "**": `.*`,
    "*": `[^/]*`,
    "?": `[^/]`,
    "{": `(?:`,
    "}": `)`,
    ",": `|`,
};
const globRegExp = (glob: string): RegExp => {
    // A leading `./` is how an anchored pattern arrives; without it the path is matched from the root anyway.
    const source = [...glob.replace(/^\.\//, ``).matchAll(/\[[^\]]*\]|\*\*\/|\*\*|\*|\?|\{|\}|,|[^*?{}[\],]+/g)]
        .map(([token]) => GLOB_TOKENS[token] ?? (token.startsWith(`[`) ? token : token.replaceAll(/[.+^$()|\\]/g, String.raw`\$&`)))
        .join(``);
    return new RegExp(`^${source}$`);
};

const includeFilter = (include: string): ((path: string) => boolean) => {
    const { globs, notGlobs } = includeGlobs(include);
    const admits = globs.map(globRegExp);
    const denies = notGlobs.map(globRegExp);
    return (path) => (admits.length === 0 || admits.some((glob) => glob.test(path))) && !denies.some((glob) => glob.test(path));
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
    // The files-to-include field, empty when the search is asked of the whole recording.
    readonly include: string;
}

export const searchWorkspace = (query: string, options: SearchOptions): WorkspaceSearchResult => {
    const { regex, note } = matcher(query, options);
    const groups: WorkspaceSearchGroup[] = [];
    let total = 0;
    for (const path of searchablePaths(options.include)) {
        const hits = (fileBody(path) ?? ``)
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
