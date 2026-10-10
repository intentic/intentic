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
import { demoQuiet, deskEdition, freshEdition } from "../mode";
import { acceptanceFiles } from "./acceptance";
import { SUPPORT_SWEEP_PATH, SUPPORT_SWEEP_SHOT } from "./browserShots";
import { choreFiles } from "./chores";
import { DESK_AGENT_DELTAS, DESK_CHANGES, DESK_DIFFS, DESK_ORIGIN_AGENTS, DESK_REPOS, DESK_SOURCES, deskSessions } from "./desk";
import { HANDOVER_CHANGE, HANDOVER_CHANGE_PATH, HANDOVER_DOCX, HANDOVER_PATH } from "./document";
import { documentationFiles } from "./docs";
import { CONFLICT_AGENT_ID, REVIEW_AGENT_ID } from "./fleet";

// acme-shop: a two-repo sandbox (web front end, api) with a handful of dirty files for the Changes review, attributed
// to three agents. Small on purpose: forty nodes prove what four thousand wouldn't. The desk recording (fixture/desk.ts)
// stands in for it at every seam below when the demo's mode says so.

// A fresh sandbox has nothing in it yet: no repository, no file, no change (mode.ts `freshEdition`).
export const REPOS: readonly string[] = freshEdition ? [] : deskEdition ? DESK_REPOS : [`web`, `api`];

// `web` matches the registry fixture's project; `api` deliberately doesn't, showing both claim outcomes. A desk has no
// remote: nothing there was ever pushed anywhere, which the sandbox's switcher carries as a standing warning. A quiet
// desk (mode.ts `demoQuiet`) has its shop's website kept somewhere else, as the one folder a maker's web person set up.
export const REMOTE_REPOS: readonly { repo: string; host: string; project: string }[] = freshEdition
    ? []
    : deskEdition
      ? demoQuiet()
          ? [{ repo: `shop-site`, host: `github.com`, project: `ada-studio/shop-site` }]
          : []
      : [
            { repo: `web`, host: `github.com`, project: `acme/shop-web` },
            { repo: `api`, host: `github.com`, project: `acme-internal/shop-api` },
        ];

// A push the demo can't make; reported in the daemon's shape (`wrote`/`committed`/`pushed`), all false here.
export const PUBLISH_REFUSAL = {
    ok: false,
    wrote: false,
    committed: false,
    pushed: false,
    branch: `main`,
    defaultBranch: `main`,
    reason: `this is the demo workspace, there is no remote to push to`,
} as const;

// Paths here are repo-relative; tool locations and the tree are root-relative instead.
// Every row carries both readings: git's own count, and the same change with comments stripped (`code`).
const CODE_CHANGES: RepoChanges[] = [
    {
        repo: `web`,
        branch: `main`,
        conflicted: [],
        staged: [],
        unstaged: [
            { path: `src/lib/checkout.ts`, status: `modified`, additions: 6, deletions: 3, code: { additions: 5, deletions: 3 } },
            { path: `src/pricing/CheckoutPanel.tsx`, status: `modified`, additions: 28, deletions: 4, code: { additions: 24, deletions: 4 } },
            { path: `tests/checkout.spec.ts`, status: `added`, additions: 44, deletions: 0, code: { additions: 40, deletions: 0 } },
            // A Word document, the one row git counts nothing for: its diff is the two versions drawn as one.
            { path: HANDOVER_CHANGE.path, status: `modified`, additions: 0, deletions: 0 },
        ],
    },
    {
        repo: `api`,
        branch: `main`,
        conflicted: [],
        staged: [],
        unstaged: [
            { path: `src/routes/checkout.ts`, status: `added`, additions: 38, deletions: 0, code: { additions: 33, deletions: 0 } },
            // Owner's own edit; this is what makes the auth agent's land refuse below.
            { path: `src/db/schema.ts`, status: `modified`, additions: 12, deletions: 2, code: { additions: 10, deletions: 2 } },
        ],
    },
];

const BASE_CHANGES: RepoChanges[] = freshEdition ? [] : deskEdition ? DESK_CHANGES : CODE_CHANGES;

// Both recordings' rows live in one table: their ids never meet, and a lookup by id needs no second switch.
const ORIGIN_AGENTS: Record<string, { title: string; provider: string }> = {
    [REVIEW_AGENT_ID]: { title: `Soft-delete the users table`, provider: `claude` },
    ...DESK_ORIGIN_AGENTS,
};

// Cumulative delta per agent, read by both the review panel and, once landed, the Changes panel.
const AGENT_DELTAS: Record<string, AgentRepoChanges[]> = {
    ...DESK_AGENT_DELTAS,
    [REVIEW_AGENT_ID]: [
        {
            repo: `api`,
            branch: `agent/soft-deletes`,
            changes: [
                { path: `src/db/schema.ts`, status: `modified`, additions: 12, deletions: 3, code: { additions: 10, deletions: 3 }, landed: false },
                { path: `src/db/migrations.ts`, status: `modified`, additions: 20, deletions: 0, code: { additions: 16, deletions: 0 }, landed: false },
                { path: `src/routes/users.ts`, status: `modified`, additions: 28, deletions: 9, code: { additions: 21, deletions: 9 }, landed: false },
            ],
            modules: [{ dir: ``, name: `@acme/api` }],
        },
        {
            repo: `web`,
            branch: `agent/soft-deletes`,
            changes: [{ path: `src/lib/api.ts`, status: `modified`, additions: 8, deletions: 2, code: { additions: 6, deletions: 2 }, landed: false }],
            modules: [{ dir: ``, name: `@acme/web` }],
        },
    ],
    [CONFLICT_AGENT_ID]: [
        {
            repo: `api`,
            branch: `agent/auth-middleware`,
            changes: [
                { path: `src/middleware/session.ts`, status: `added`, additions: 52, deletions: 0, code: { additions: 41, deletions: 0 }, landed: false },
                { path: `src/server.ts`, status: `modified`, additions: 14, deletions: 13, code: { additions: 12, deletions: 13 }, landed: false },
                { path: `src/db/schema.ts`, status: `modified`, additions: 6, deletions: 5, code: { additions: 5, deletions: 5 }, landed: false },
            ],
            modules: [{ dir: ``, name: `@acme/api` }],
            // What landing takes on: the review's one quiet line per manifest.
            addedDependencies: [{ path: `package.json`, added: [`jose`] }],
        },
    ],
};

// A copy the agent left on no branch, whose work could not be carried onto its own: what no land reaches.
const ELSEWHERE: Record<string, AgentChanges[`elsewhere`]> = {
    [CONFLICT_AGENT_ID]: [{ repo: `web`, carried: false, uncommitted: true }],
};

// `diverged` needs a rebase; `workspace` is the owner's uncommitted edit, which no rebase reaches.
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

// Which agents have landed; flips their rows into the main tree's Changes list.
const landedAgents = new Set<string>();

export const gitChanges = (): GitChanges => {
    // Copy per read: a land's additions don't mutate the base for the next read.
    const repos = structuredClone(BASE_CHANGES);
    for (const agentId of landedAgents) {
        for (const delta of AGENT_DELTAS[agentId] ?? []) {
            const target = repos.find((repo) => repo.repo === delta.repo);
            if (target === undefined) {
                continue;
            }
            const origins = (target.origins ??= {});
            for (const change of delta.changes) {
                // Existing row gains an author rather than duplicating; two agents can land the same file.
                if (!target.unstaged.some((row) => row.path === change.path)) {
                    target.unstaged.push({ path: change.path, status: change.status, additions: change.additions, deletions: change.deletions });
                }
                origins[change.path] = [...(origins[change.path] ?? []), agentId];
            }
        }
    }
    return { repos, originAgents: ORIGIN_AGENTS };
};

/** Cumulative delta for one agent, plus why its last land refused. */
export const agentChanges = (agentId: string): AgentChanges => {
    const landed = landedAgents.has(agentId);
    const conflicts = CONFLICTS[agentId];
    const repos = structuredClone(AGENT_DELTAS[agentId] ?? []);
    for (const repo of repos) {
        for (const change of repo.changes) {
            change.landed = landed;
        }
    }
    // Every row stays listed; nothing here is ever absorbed into the tree's history.
    const elsewhere = ELSEWHERE[agentId];
    return { repos, absorbed: 0, ...(conflicts === undefined ? {} : { conflicts }), ...(elsewhere === undefined ? {} : { elsewhere }) };
};

// Delta becomes the tree's uncommitted work, attributed to the agent. An agent with a recorded conflict refuses
// instead: nothing applied, same report the panel renders.
export const landAgentDelta = (agentId: string): LandResult => {
    const conflicts = CONFLICTS[agentId];
    // `changed` either way: every demo agent carries a delta, so a refusal here is one that judged real work and
    // declined it, not a press that found the branch empty.
    if (conflicts !== undefined) {
        return { landed: false, changed: true, conflicts };
    }
    landedAgents.add(agentId);
    return { landed: true, changed: true };
};

/** Root-relative paths a land just wrote, for the `workspaceChanged` refresh frame. */
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
    // Soft delete: rows are retired, never removed, every read filters on this.
    deletedAt: timestamp("deleted_at"),
});

export const liveUsers = () => db.select().from(users).where(isNull(users.deletedAt));
`;

// Files the featured run edits; turn.ts shares these constants so the tool card and diff can't drift.
export const CHECKOUT_LIB_BEFORE = `export const checkout = async (priceId: string) => {
    throw new Error("NotImplemented");
};
`;

export const CHECKOUT_LIB_AFTER = `export const checkout = async (priceId: string) => {
    const response = await api.post("/checkout/session", { priceId });
    window.location.assign(response.url);
};
`;

// Endpoint the run writes first; the only file in the story that's created, not edited.
export const CHECKOUT_ROUTE = `import { stripe } from "../lib/stripe";

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

// Last edit of the run; answers the question card's CTA-during-redirect prompt with 'inline spinner'.
const CHECKOUT_PANEL_AFTER = `import { useState } from "react";
import { Spinner } from "../common/Spinner";
import { checkout } from "../lib/checkout";
import type { Plan } from "./plans";

// Stripe takes a moment to answer, and a CTA that still looks idle while it does is one people press twice, so
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

// Covers the run's last todo: redirect, failure path, and the CTA that can't be pressed twice.
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

// The route file whole, not just the one function the change is about: a reviewer reads a change in its file, and the
// soft-delete is three small edits there (the delete becomes an update, and both reads skip retired rows), which is the
// diff the review hero is a picture of. Lines kept short so neither side of a split diff wraps.
const USERS_ROUTE_BEFORE = `import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";

export const listUsers = () => db.select().from(users);

export const getUser = async (id: string) => {
    const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, id));
    return user ?? null;
};

export const deleteUser = async (id: string) => {
    await db
        .delete(users)
        .where(eq(users.id, id));
    return { ok: true };
};
`;

const USERS_ROUTE_AFTER = `import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { liveUsers, users } from "../db/schema";

// Retired rows stay in the table; no read returns them.
const live = isNull(users.deletedAt);

export const listUsers = () => liveUsers();

export const getUser = async (id: string) => {
    const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, id), live));
    return user ?? null;
};

export const deleteUser = async (id: string) => {
    await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, id));
    return { ok: true };
};
`;

// Keyed `repo/path` so same paths across repos don't collide; no `before` renders as an addition.
const DIFFS: Record<string, FileDiff> = {
    ...DESK_DIFFS,
    "api/src/db/schema.ts": { before: SOFT_DELETE_BEFORE, after: SOFT_DELETE_AFTER },
    "api/src/routes/users.ts": { before: USERS_ROUTE_BEFORE, after: USERS_ROUTE_AFTER },
    "api/src/routes/checkout.ts": { after: CHECKOUT_ROUTE },
    "web/src/lib/checkout.ts": { before: CHECKOUT_LIB_BEFORE, after: CHECKOUT_LIB_AFTER },
    "web/src/pricing/CheckoutPanel.tsx": { before: CHECKOUT_PANEL_BEFORE, after: CHECKOUT_PANEL_AFTER },
    "web/tests/checkout.spec.ts": { after: CHECKOUT_SPEC },
    [HANDOVER_CHANGE_PATH]: { binary: true },
};

// Prose, added-only: same text both sides shows no diff; a comment would get stripped by hide-comments.
const UNRECORDED = `This file's diff is not one of the few the demo carries in full.

Open web/src/lib/checkout.ts or api/src/db/schema.ts to read one it does.
`;

export const fileDiff = (repo: string, path: string): FileDiff => DIFFS[`${repo}/${path}`] ?? { after: UNRECORDED };

const README = `# acme-shop

A two-repo product: the storefront (\`web\`) and its API (\`api\`).

This workspace is a **recording**. Every panel around it is the real intentic UI, wired to a fixture
instead of a daemon, so you can open anything, but nothing here runs.

Start a sandbox on your own machine and the same surfaces point at your repos.
`;

// Each repo's own front page and manifest, so a folder read through one file name (the home's cover) has something to
// show in every folder: the storefront and the API each say what they are in both.
const WEB_README = `# web

The storefront: pricing, checkout and the signup flow, built with React and Vite.

## Run it

\`\`\`sh
pnpm install
pnpm dev        # http://localhost:5173
\`\`\`

## Where things are

- \`src/pricing/\`: the pricing page and the checkout panel beside it
- \`src/lib/checkout.ts\`: talks to the API's \`/checkout\` route
- \`tests/\`: Playwright specs, one per flow

Checkout needs the API running; point \`VITE_API_URL\` at it.
`;

const API_README = `# api

The storefront's backend: users, checkout sessions and the Stripe webhook.

| Route | Does |
| --- | --- |
| \`POST /checkout\` | Opens a Stripe checkout session for a plan |
| \`POST /stripe/webhook\` | Marks a session paid when Stripe says so |
| \`GET /users/:id\` | One user, soft-deleted ones excluded |

Run it with \`pnpm dev\`; it listens on port 8080 and reads \`DATABASE_URL\` and \`STRIPE_SECRET_KEY\`.
`;

const WEB_PACKAGE = `{
    "name": "@acme/web",
    "private": true,
    "type": "module",
    "scripts": {
        "dev": "vite",
        "build": "vite build",
        "test": "playwright test"
    },
    "dependencies": {
        "react": "^19.1.0",
        "react-dom": "^19.1.0"
    },
    "devDependencies": {
        "@playwright/test": "^1.55.0",
        "vite": "^7.1.0"
    }
}
`;

const API_PACKAGE = `{
    "name": "@acme/api",
    "private": true,
    "type": "module",
    "scripts": {
        "dev": "tsx watch src/server.ts",
        "build": "tsc -p .",
        "migrate": "tsx src/db/migrations.ts"
    },
    "dependencies": {
        "hono": "^4.9.0",
        "postgres": "^3.4.7",
        "stripe": "^18.4.0"
    }
}
`;

// One flat, root-relative table backing the tree, every read, search and write, so a file only needs adding here once.
// A string is the real body; a number is a size-only stand-in. A missing path answers 404. Mutable: writes here persist
// until reload.

/** Built once at page load: a run recorded '42 minutes ago' stays 42 minutes before arrival. */
const RECORDED_AT = Date.now();

const SOURCES: [string, string | number][] = [
    [`README.md`, README],
    [SUPPORT_SWEEP_PATH, SUPPORT_SWEEP_SHOT],

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
    [`web/README.md`, WEB_README],
    [`web/package.json`, WEB_PACKAGE],
    [`web/pnpm-lock.yaml`, 184_600],
    [`web/vite.config.ts`, 512],
    // Ignored: tree lists it grayed, and expanding it is what /workspace/children answers.
    [`web/node_modules/react/package.json`, 3_120],
    [`web/node_modules/vite/package.json`, 4_040],

    [`api/src/routes/checkout.ts`, CHECKOUT_ROUTE],
    [`api/src/routes/users.ts`, 2_460],
    [`api/src/db/schema.ts`, SOFT_DELETE_AFTER],
    [`api/src/db/migrations.ts`, 1_180],
    [`api/src/stripe.ts`, 460],
    [`api/src/server.ts`, 1_640],
    [`api/.github/workflows/api.yml`, 980],
    [`api/Dockerfile`, 640],
    [`api/README.md`, API_README],
    [`api/package.json`, API_PACKAGE],
    [`api/pnpm-lock.yaml`, 96_200],

    // A dropped archive: listed as the file it is, and entered like a folder (ARCHIVES below answers what is inside).
    [`drop/brand-kit.zip`, 48_200],
    // Its real length, since /workspace/raw serves this one's real bytes (fixture/document.ts).
    [HANDOVER_PATH, HANDOVER_DOCX.length],
    [HANDOVER_CHANGE_PATH, HANDOVER_DOCX.length],
];

// What an archive holds, which the daemon answers by unpacking it out of sight. Keyed by the archive's own path and
// separate from FILES on purpose: the tree must list `brand-kit.zip` as a FILE, and a member path under FILES would
// make the walk build a folder of that name instead.
const ARCHIVES = new Map<string, [string, string | number][]>([
    [
        `drop/brand-kit.zip`,
        [
            [`logo.svg`, 4_120],
            [`README.md`, `# Brand kit\n\nLogos, the type scale, and the palette as tokens.\n`],
            [`palette/tokens.json`, 1_860],
            [`palette/swatches.png`, 21_400],
            [`type/Inter-Regular.woff2`, 18_900],
        ],
    ],
]);

// The desk carries its own documents and none of the extension-owned files: those belong to the code repositories.
const FILES = new Map<string, string | number>(
    freshEdition
        ? []
        : deskEdition
          ? DESK_SOURCES
          : [...SOURCES, ...acceptanceFiles(RECORDED_AT), ...documentationFiles(RECORDED_AT), ...choreFiles(RECORDED_AT)],
);

// Daemon's ignore scope; node_modules stays listed since a tree without it looks uninstalled.
const IGNORED_DIRS = new Set([`node_modules`, `.git`, `dist`, `.turbo`, `.cache`]);

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentOf = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);
const sizeOf = (entry: string | number): number => (typeof entry === `number` ? entry : entry.length);
const isIgnored = (path: string): boolean => path.split(`/`).some((segment) => IGNORED_DIRS.has(segment));

// When a fixture file "last changed": the same moment for a path on every load, spread over the last ninety days, so
// the home grouped by date (homeOrder.ts) has a Today, a Yesterday and older months to draw. FNV-1a over the path.
const FIXTURE_SPAN_MINUTES = 90 * 24 * 60;
const mtimeOf = (path: string, now = Date.now()): number => {
    let hash = 0x81_1c_9d_c5;
    for (const char of path) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 0x01_00_01_93) >>> 0;
    }
    return now - (hash % FIXTURE_SPAN_MINUTES) * 60_000;
};

// Entry while the walk builds the tree: a mutable-`children` WorkspaceTreeEntry, since folding a flat table into one
// means pushing into that array.
interface TreeNode {
    name: string;
    path: string;
    type: "file" | "dir";
    size?: number;
    mtime?: number;
    ignored?: boolean;
    children?: TreeNode[];
}

// Directories first, then by name: the order the daemon's walk returns.
const ordered = (entries: TreeNode[]): TreeNode[] =>
    entries.toSorted((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === `dir` ? -1 : 1));

// Nested tree for GET /workspace/tree. An ignored directory is listed with no `children`, meaning not descended into,
// distinct from genuinely empty.
export const workspaceTree = (): WorkspaceTree => {
    const roots: TreeNode[] = [];
    const folders = new Map<string, TreeNode>();
    // Children array for a path; undefined when an ancestor is ignored and never descended.
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
        childrenAt(parentOf(path))?.push({ name: nameOf(path), path, type: `file`, size: sizeOf(entry), mtime: mtimeOf(path) });
    }
    for (const folder of folders.values()) {
        folder.children = folder.children === undefined ? undefined : ordered(folder.children);
    }
    // Nothing to sweep: every folder here exists because a file put it there.
    return { root: WORKSPACE_ROOT, hidden: 0, tree: ordered(roots), barren: [] };
};

// One level of an archive's contents, under the archive's own path, the way the daemon answers for a zip or tar.
// `at` is the archive; `inside` is where in it, "" for its top level.
const archiveChildren = (at: string, inside: string, members: readonly [string, string | number][]): WorkspaceChildren => {
    const prefix = inside === `` ? `` : `${inside}/`;
    const entries = new Map<string, TreeNode>();
    for (const [member, contents] of members) {
        if (!member.startsWith(prefix)) {
            continue;
        }
        const rest = member.slice(prefix.length);
        const name = rest.includes(`/`) ? rest.slice(0, rest.indexOf(`/`)) : rest;
        const child = `${at}/${prefix}${name}`;
        entries.set(name, rest.includes(`/`) ? { name, path: child, type: `dir` } : { name, path: child, type: `file`, size: sizeOf(contents) });
    }
    return { entries: ordered([...entries.values()]), hidden: 0 };
};

// The archive a listing is of, and where inside it, when the path names one or sits under one.
const archiveAt = (path: string): { at: string; inside: string; members: readonly [string, string | number][] } | undefined => {
    for (const [at, members] of ARCHIVES) {
        if (path === at || path.startsWith(`${at}/`)) {
            return { at, inside: path === at ? `` : path.slice(at.length + 1), members };
        }
    }
    return undefined;
};

/** One directory's immediate children: the lazy-load behind an ignored dir, or what an archive holds. */
export const workspaceChildren = (path: string): WorkspaceChildren => {
    const archive = archiveAt(path);
    if (archive !== undefined) {
        return archiveChildren(archive.at, archive.inside, archive.members);
    }
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

// Unrecorded file says so when opened, rather than an empty buffer (looks broken) or invented content.
const unrecordedBody = (path: string): string => `// ${path}\n//\n// The demo carries a few files in full; this one is listed but not recorded.\n`;

// A file inside a dropped archive, read through it the way the daemon reads one out of its unpacked copy.
const archiveMember = (path: string): string | number | undefined => {
    const archive = archiveAt(path);
    return archive === undefined || archive.inside === `` ? undefined : archive.members.find(([member]) => member === archive.inside)?.[1];
};

export const fileBody = (path: string): string | undefined => {
    const entry = FILES.get(path) ?? archiveMember(path);
    return entry === undefined ? undefined : typeof entry === `number` ? unrecordedBody(path) : entry;
};

// GET /workspace/file: the whole file as one window. A path not carried answers `present: false`, same as the daemon,
// not a failure.
export const readFile = (
    path: string,
): { present: true; path: string; content: string; size: number; offset: number; bytes: number; shared: true } | { present: false; path: string } => {
    const content = fileBody(path);
    return content === undefined
        ? { present: false, path }
        : { present: true, path, content, size: content.length, offset: 0, bytes: content.length, shared: true };
};

/** POST /workspace/upload: writes panels make, an acknowledgement, a story, a published document. */
export const writeFile = (path: string, content: string): void => {
    FILES.set(path, content);
};

// What deletes took, by trash id, so Undo can put it back, as the daemon's trash does.
const TRASH = new Map<string, { readonly path: string; readonly files: ReadonlyMap<string, string | number> }>();
let trashed = 0;

/** DELETE /workspace/entry: a file, or a directory and everything under it, into the trash. */
export const deleteEntry = (path: string): { ok: true; trashed?: string } => {
    const files = new Map([...FILES].filter(([candidate]) => candidate === path || candidate.startsWith(`${path}/`)));
    for (const candidate of files.keys()) {
        FILES.delete(candidate);
    }
    if (files.size === 0) {
        return { ok: true };
    }
    trashed += 1;
    const id = `demo-${trashed.toString(16).padStart(8, `0`)}`;
    TRASH.set(id, { path, files });
    return { ok: true, trashed: id };
};

/** POST /workspace/restore: back where it was, or beside a newcomer under a `(restored)` name; undefined for an id
 * the trash no longer holds. */
export const restoreEntry = (id: string): { path: string } | undefined => {
    const held = TRASH.get(id);
    if (held === undefined) {
        return undefined;
    }
    TRASH.delete(id);
    const taken = (path: string): boolean => [...FILES.keys()].some((candidate) => candidate === path || candidate.startsWith(`${path}/`));
    const dot = held.path.lastIndexOf(`.`);
    const slash = held.path.lastIndexOf(`/`);
    const [stem, ext] = dot > slash + 1 ? [held.path.slice(0, dot), held.path.slice(dot)] : [held.path, ``];
    let target = held.path;
    for (let n = 1; taken(target); n += 1) {
        target = `${stem} (restored${n === 1 ? `` : ` ${n}`})${ext}`;
    }
    for (const [path, entry] of held.files) {
        FILES.set(target + path.slice(held.path.length), entry);
    }
    return { path: target };
};

// Sessions window: the sandbox's whole history, more than the fleet board's today-only view.
export const sessions = (now: number): SessionSummary[] => {
    if (freshEdition) {
        return [];
    }
    if (deskEdition) {
        return deskSessions(now);
    }
    const hour = 3_600_000;
    return [
        { id: `ses_01j9checkout`, title: `Add Stripe checkout to the pricing page`, updatedAt: now - 90_000 },
        { id: `ses_01j9flaky`, title: `Fix the flaky signup e2e test`, updatedAt: now - 2 * 60_000 },
        { id: `ses_01j9auth`, title: `Refactor the auth middleware onto the new session store`, updatedAt: now - 11 * 60_000 },
        { id: `ses_01j9latency`, title: `Investigate the p99 latency spike on /checkout`, updatedAt: now - 60_000 },
        { id: `ses_01j9soft`, title: `Soft-delete the users table`, updatedAt: now - 18 * 60_000 },
        { id: `ses_01j9notes`, title: `Draft the release notes for 2.4`, updatedAt: now - 34 * 60_000 },
        { id: `ses_01j9audit`, title: `Nightly dependency audit, 3 advisories, 2 patched`, updatedAt: now - 7 * hour },
        { id: `ses_01j9seo`, title: `Add structured data to the product pages`, updatedAt: now - 26 * hour },
        { id: `ses_01j9emails`, title: `Move transactional emails to the queue`, updatedAt: now - 2 * 24 * hour },
        { id: `ses_01j9upgrade`, title: `Upgrade to Vite 8 and drop the CJS shims`, updatedAt: now - 3 * 24 * hour },
        { id: `ses_01j9a11y`, title: `Fix the keyboard trap in the plan switcher`, updatedAt: now - 4 * 24 * hour },
        { id: `ses_01j9docs`, title: `Document the checkout webhook contract`, updatedAt: now - 6 * 24 * hour },
    ];
};

// Fixture's answer to GET /workspace/search: a real text search (literal or regex, case rules, per-line spans). Smart
// scope can't rank by meaning, so it answers with the same matcher and a note.
// Searches files with a real body, ignored paths excluded — the same two limits the daemon's search has, so a hit here
// is a hit there too.
const searchablePaths = (include: string, dir: string): string[] => {
    const admits = includeFilter(include);
    // The open project narrows the search the way the daemon's `dir` does: a prefix, applied before the include globs.
    const inside = (path: string): boolean => dir === `` || path.startsWith(`${dir}/`);
    return [...FILES].flatMap(([path, entry]) => (typeof entry === `string` && !isIgnored(path) && inside(path) && admits(path) ? [path] : []));
};

// Panel's include field, parsed by the same `includeGlobs` the daemon uses; only matching those globs is local here,
// same as the text matcher.
// Each token maps to one regex fragment, else escaped; `**/` may span zero directories.
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
    // Leading `./` marks an anchored pattern; without it matching still starts at the root.
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

// Literal text unless `.*` is on; an invalid regex falls back to literal matching, same as the daemon.
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
        return { regex: new RegExp(wrap(escaped), flags), note: `Pattern isn't a valid regular expression, searched for it as literal text.` };
    }
};

interface SearchOptions {
    readonly smart: boolean;
    readonly literal: boolean;
    readonly word: boolean;
    readonly caseSensitive: boolean;
    // Files-to-include field; empty means the whole recording.
    readonly include: string;
    // The open project's folder, root-relative; empty means the whole recording.
    readonly dir: string;
}

export const searchWorkspace = (query: string, options: SearchOptions): WorkspaceSearchResult => {
    const { regex, note } = matcher(query, options);
    const groups: WorkspaceSearchGroup[] = [];
    let total = 0;
    for (const path of searchablePaths(options.include, options.dir)) {
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
    const smartNote = `This recording answers Smart like Text: ranking by meaning needs your own sandbox's index.`;
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
