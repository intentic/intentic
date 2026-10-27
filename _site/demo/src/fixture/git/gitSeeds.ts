import { HANDOVER_CHANGE } from "../document";
import { fileBody, fileDiff } from "../workspace";

// What each repo's history held before the page loaded: the commits, the refs on them, what the remote holds and what
// was set aside. daemon/gitGraph.ts builds the graph from these once per page load, giving every commit a sha; every
// later commit, merge, rebase and push made in the page joins that graph. Written oldest first. The tips of the files the
// Changes panel shows as modified hold exactly the `before` side of that panel's diff, so a commit's diff and the
// working tree's agree about where the file stood.

/** A file a commit records as not text, which git counts nothing for. */
export class Binary {
    readonly countable = false;
}
export const BINARY = new Binary();

/** A commit's rewrite of what the file held before it. */
export class Edit {
    constructor(readonly apply: (before: string) => string) {}
}
const edit = (apply: (before: string) => string): Edit => new Edit(apply);

/** A file as a commit leaves it: its whole body, deleted (`null`), binary, or the previous body rewritten. */
export type SeedBody = string | null | Binary | Edit;

/** What a seeded body leaves a file as, given what it held before. */
export const applyBody = (body: SeedBody, before: string | Binary | undefined): string | Binary | undefined => {
    if (body instanceof Edit) {
        return body.apply(before instanceof Binary || before === undefined ? `` : before);
    }
    return body ?? undefined;
};

/** Who wrote a commit: the owner, their teammate, or an agent, which commits as the daemon's own author. */
export type SeedAuthor = `owner` | `teammate` | `agent`;

export interface SeedCommit {
    readonly id: string;
    readonly subject: string;
    readonly body?: string;
    readonly by: SeedAuthor;
    readonly hoursAgo: number;
    /** What it came from; the commit listed before it when left out. A merge names both. */
    readonly parents?: readonly string[];
    readonly files: Readonly<Record<string, SeedBody>>;
}

export interface SeedStash {
    readonly subject: string;
    readonly branch: string;
    readonly hoursAgo: number;
    /** The commit it was taken on. */
    readonly on: string;
    readonly files: Readonly<Record<string, SeedBody>>;
}

export interface RepoSeed {
    readonly commits: readonly SeedCommit[];
    /** The checked-out branch. */
    readonly head: string;
    readonly branches: Readonly<Record<string, string>>;
    /** Which remote-tracking branch each local one follows (`origin/main`). */
    readonly upstreams?: Readonly<Record<string, string>>;
    /** The remote's branches as this repo last fetched them, by branch name. */
    readonly fetched?: Readonly<Record<string, string>>;
    /** What the remote actually holds now, which a fetch brings down. */
    readonly server?: Readonly<Record<string, string>>;
    readonly tags?: Readonly<Record<string, string>>;
    readonly pushedTags?: readonly string[];
    readonly stashes?: readonly SeedStash[];
    /** A cherry-pick a terminal left stopped on a conflict, picking this commit: the explorable state Abort ends. */
    readonly halted?: string;
}

/** The `before` side of a file the Changes panel shows modified: what its last commit left. */
const committed = (repo: string, path: string): string => fileDiff(repo, path).before ?? ``;
/** A file's body as the tree holds it now, for one whose last commit is the state on disk. */
const onDisk = (path: string): string => fileBody(path) ?? ``;

const append = (lines: string): Edit => edit((before) => `${before}${lines}`);

const PLANS_V1 = `export interface Plan {
    readonly id: string;
    readonly name: string;
    readonly monthly: number;
}

export const plans: Plan[] = [
    { id: "starter", name: "Starter", monthly: 0 },
    { id: "growth", name: "Growth", monthly: 29 },
    { id: "team", name: "Team", monthly: 79 },
];
`;

const PRICING_V1 = `import { plans } from "./plans";

export const PricingPage = () => (
    <section className="pricing">
        {plans.map((plan) => (
            <article key={plan.id} className="plan">
                <h2>{plan.name}</h2>
                <p>{plan.monthly === 0 ? "Free" : \`$\${plan.monthly} a month\`}</p>
            </article>
        ))}
    </section>
);
`;

const SIGNUP_SPEC = `import { expect, test } from "@playwright/test";

test("a visitor signs up from the pricing page", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByRole("link", { name: "Start free" }).click();
    await page.getByLabel("Email").fill("new@acme.dev");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/welcome/);
});
`;

const CI_V1 = `name: ci
on: [push]
jobs:
    e2e:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: pnpm/action-setup@v4
            - run: pnpm install --frozen-lockfile
            - run: pnpm exec playwright install --with-deps chromium
            - run: pnpm test
`;

const API_CLIENT = `const base = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(\`\${base}\${path}\`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(\`\${method} \${path} answered \${response.status}\`);
    }
    return response.json();
};

export const api = {
    get: (path: string) => call("GET", path),
    post: (path: string, body: unknown) => call("POST", path, body),
};
`;

const web: RepoSeed = {
    commits: [
        {
            id: `w1`,
            subject: `Scaffold the storefront with Vite and React`,
            by: `owner`,
            hoursAgo: 960,
            files: {
                "package.json": onDisk(`web/package.json`).replace(`"@playwright/test": "^1.55.0",\n        `, ``),
                "src/main.tsx": `import { createRoot } from "react-dom/client";\nimport { App } from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n`,
                "src/App.tsx": `export const App = () => <main>acme shop</main>;\n`,
                "vite.config.ts": `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [react()] });\n`,
                "README.md": `# web\n\nThe storefront.\n`,
            },
        },
        {
            id: `w2`,
            subject: `Add the pricing page with three plans`,
            by: `owner`,
            hoursAgo: 900,
            files: { "src/pricing/plans.ts": PLANS_V1, "src/pricing/PricingPage.tsx": PRICING_V1 },
        },
        {
            id: `w3`,
            subject: `Signup flow and its end-to-end spec`,
            body: `One spec per flow from here on, so a failing run names the flow it broke.`,
            by: `teammate`,
            hoursAgo: 820,
            files: {
                "src/App.tsx": `import { PricingPage } from "./pricing/PricingPage";\nimport { Signup } from "./signup/Signup";\n\nexport const App = () => (location.pathname === "/signup" ? <Signup /> : <PricingPage />);\n`,
                "tests/signup.spec.ts": SIGNUP_SPEC,
                "package.json": onDisk(`web/package.json`),
            },
        },
        { id: `w4`, subject: `CI: run Playwright on every push`, by: `teammate`, hoursAgo: 790, files: { ".github/workflows/ci.yml": CI_V1 } },
        { id: `w5`, subject: `Talk to the API through one client`, by: `owner`, hoursAgo: 600, files: { "src/lib/api.ts": API_CLIENT } },
        {
            id: `w6`,
            subject: `Annual billing toggle on the pricing page`,
            by: `agent`,
            hoursAgo: 420,
            files: {
                "src/pricing/plans.ts": edit((before) => before.replace(`readonly monthly: number;\n`, `readonly monthly: number;\n    readonly annual: number;\n`)),
                "src/pricing/PricingPage.tsx": edit((before) =>
                    before
                        .replace(`import { plans } from "./plans";\n`, `import { useState } from "react";\nimport { plans } from "./plans";\n`)
                        .replace(`export const PricingPage = () => (\n`, `export const PricingPage = () => {\n    const [annual, setAnnual] = useState(false);\n    return (\n`)
                        .replace(/\);\n$/u, `);\n};\n`)),
            },
        },
        {
            id: `w7`,
            subject: `Fix the flaky signup e2e test`,
            body: `The spec clicked before the plan cards finished loading. It now waits for the Starter card, the same way a person would.`,
            by: `agent`,
            hoursAgo: 300,
            files: {
                "tests/signup.spec.ts": edit((before) =>
                    before.replace(`await page.goto("/pricing");\n`, `await page.goto("/pricing");\n    await expect(page.getByRole("heading", { name: "Starter" })).toBeVisible();\n`)),
            },
        },
        {
            id: `w8`,
            subject: `Checkout panel beside the plan cards`,
            by: `owner`,
            hoursAgo: 200,
            files: {
                "src/pricing/CheckoutPanel.tsx": committed(`web`, `src/pricing/CheckoutPanel.tsx`),
                "src/lib/checkout.ts": committed(`web`, `src/lib/checkout.ts`),
            },
        },
        {
            id: `wa1`,
            parents: [`w7`],
            subject: `Rewrite the plan copy for annual pricing`,
            by: `teammate`,
            hoursAgo: 180,
            files: { "src/pricing/plans.ts": edit((before) => before.replaceAll(`monthly: 29 }`, `monthly: 29, annual: 290 }`).replaceAll(`monthly: 79 }`, `monthly: 79, annual: 790 }`)) },
        },
        {
            id: `w9`,
            parents: [`w8`, `wa1`],
            subject: `Merge branch 'feature/annual-copy'`,
            by: `owner`,
            hoursAgo: 150,
            files: { "src/pricing/plans.ts": edit((before) => before.replaceAll(`monthly: 29 }`, `monthly: 29, annual: 290 }`).replaceAll(`monthly: 79 }`, `monthly: 79, annual: 790 }`)) },
        },
        { id: `w10`, subject: `Add the handover notes for the checkout launch`, by: `owner`, hoursAgo: 96, files: { [HANDOVER_CHANGE.path]: BINARY } },
        {
            id: `w11`,
            subject: `Bump React to 19.1`,
            by: `agent`,
            hoursAgo: 60,
            files: { "pnpm-lock.yaml": `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^19.1.0\n        version: 19.1.0\n` },
        },
        { id: `w12`, subject: `Document how to run checkout locally`, by: `owner`, hoursAgo: 20, files: { "README.md": onDisk(`web/README.md`) } },
        // On the remote only: what the teammate pushed since this repo last pulled.
        { id: `ws1`, parents: [`w11`], subject: `Tighten the CI cache key`, by: `teammate`, hoursAgo: 8, files: { ".github/workflows/ci.yml": append(`            - run: pnpm store prune\n`) } },
        {
            id: `ws2`,
            subject: `Copy: say "per seat" on the Team plan`,
            by: `teammate`,
            hoursAgo: 5,
            files: { "src/pricing/plans.ts": edit((before) => before.replace(`name: "Team"`, `name: "Team (per seat)"`)) },
        },
        // The soft-deletes conversation's own branch: the agent works in a worktree whose branch shares this repo's refs.
        {
            id: `wg1`,
            parents: [`w12`],
            subject: `Read users through the live-users endpoint`,
            by: `agent`,
            hoursAgo: 1,
            files: { "src/lib/api.ts": append(`\nexport const liveUsers = () => api.get("/users?live=1");\n`) },
        },
    ],
    head: `main`,
    branches: { main: `w12`, "feature/annual-copy": `wa1`, "agent/soft-deletes": `wg1` },
    upstreams: { main: `origin/main`, "feature/annual-copy": `origin/feature/annual-copy` },
    fetched: { main: `ws2`, "feature/annual-copy": `wa1` },
    server: { main: `ws2`, "feature/annual-copy": `wa1` },
    tags: { "v2.2.0": `w4`, "v2.3.0": `w7` },
    pushedTags: [`v2.2.0`, `v2.3.0`],
    stashes: [
        {
            subject: `try a sticky checkout summary`,
            branch: `main`,
            hoursAgo: 30,
            on: `w10`,
            files: {
                "src/pricing/PricingPage.tsx": edit((before) => before.replace(`<section className="pricing">`, `<section className="pricing pricing--sticky-summary">`)),
            },
        },
    ],
};

const SERVER_V1 = `import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

export default { port: 8080, fetch: app.fetch };
`;

const MIGRATIONS = `import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./client";

await migrate(db, { migrationsFolder: "drizzle" });
`;

const API_WORKFLOW = `name: api
on:
    push:
        branches: [main]
jobs:
    image:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - run: docker build -t ghcr.io/acme/shop-api:\${{ github.sha }} .
            - run: docker push ghcr.io/acme/shop-api:\${{ github.sha }}
`;

const api: RepoSeed = {
    commits: [
        {
            id: `a1`,
            subject: `Hono server with a health route`,
            by: `owner`,
            hoursAgo: 980,
            files: {
                "package.json": onDisk(`api/package.json`).replace(`,\n        "stripe": "^18.4.0"`, ``),
                "src/server.ts": SERVER_V1,
                "Dockerfile": `FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN corepack enable && pnpm install --prod\nCMD ["pnpm", "start"]\n`,
                "README.md": `# api\n\nThe storefront's backend.\n`,
            },
        },
        {
            id: `a2`,
            subject: `Users table and the first migration`,
            by: `owner`,
            hoursAgo: 940,
            files: {
                "src/db/schema.ts": committed(`api`, `src/db/schema.ts`).replace(`    createdAt: timestamp("created_at").notNull().defaultNow(),\n`, ``),
                "src/db/migrations.ts": MIGRATIONS,
            },
        },
        { id: `a3`, subject: `GET and DELETE /users/:id`, by: `teammate`, hoursAgo: 880, files: { "src/routes/users.ts": committed(`api`, `src/routes/users.ts`) } },
        { id: `a4`, subject: `Deploy workflow for the API image`, by: `teammate`, hoursAgo: 850, files: { ".github/workflows/api.yml": API_WORKFLOW } },
        {
            id: `a5`,
            subject: `Stripe client behind one module`,
            body: `Everything that talks to Stripe imports it from here, so rotating the key is one place.`,
            by: `owner`,
            hoursAgo: 500,
            files: {
                "src/stripe.ts": `import Stripe from "stripe";\n\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");\n`,
                "package.json": onDisk(`api/package.json`),
            },
        },
        { id: `a6`, subject: `Add createdAt to users`, by: `agent`, hoursAgo: 410, files: { "src/db/schema.ts": committed(`api`, `src/db/schema.ts`) } },
        {
            id: `a7`,
            subject: `Stripe webhook marks sessions paid`,
            by: `agent`,
            hoursAgo: 330,
            files: {
                "src/server.ts": edit((before) =>
                    before.replace(
                        `export default`,
                        `app.post("/stripe/webhook", async (c) => {\n    const event = stripe.webhooks.constructEvent(await c.req.text(), c.req.header("stripe-signature") ?? "", secret);\n    if (event.type === "checkout.session.completed") {\n        await markPaid(event.data.object.id);\n    }\n    return c.body(null, 204);\n});\n\nexport default`,
                    )),
            },
        },
        {
            id: `a8`,
            subject: `Log slow queries over 200 ms`,
            by: `owner`,
            hoursAgo: 96,
            files: { "src/server.ts": edit((before) => before.replace(`const app = new Hono();\n`, `const app = new Hono();\n\napp.use(slowQueryLog({ thresholdMs: 200 }));\n`)) },
        },
        { id: `ar1`, subject: `Rate-limit /checkout per IP`, by: `owner`, hoursAgo: 30, files: { "src/server.ts": append(`\napp.use("/checkout", rateLimit({ perMinute: 20 }));\n`) } },
        {
            id: `af1`,
            parents: [`a8`],
            subject: `Retry webhook deliveries with backoff`,
            by: `teammate`,
            hoursAgo: 6,
            files: { "src/server.ts": edit((before) => before.replace(`await markPaid(event.data.object.id);`, `await withBackoff(() => markPaid(event.data.object.id));`)) },
        },
        {
            id: `ag1`,
            parents: [`a8`],
            subject: `Soft-delete users instead of removing them`,
            by: `agent`,
            hoursAgo: 2,
            files: { "src/db/migrations.ts": append(`\n// 0004: users.deleted_at, nullable, so retiring a user keeps their orders.\n`) },
        },
        {
            id: `ah1`,
            parents: [`a8`],
            subject: `Move sessions onto the new session store`,
            by: `agent`,
            hoursAgo: 3,
            files: { "src/server.ts": edit((before) => before.replace(`const app = new Hono();\n`, `const app = new Hono();\n\napp.use(session({ store: sessionStore }));\n`)) },
        },
    ],
    head: `main`,
    branches: { main: `a8`, "feature/rate-limits": `ar1`, "agent/soft-deletes": `ag1`, "agent/auth-middleware": `ah1` },
    upstreams: { main: `origin/main` },
    fetched: { main: `a8` },
    // A teammate's branch this repo has not fetched yet.
    server: { main: `a8`, "fix/webhook-retries": `af1` },
    tags: { "v2.2.0": `a4`, "v2.3.0": `a7` },
    pushedTags: [`v2.2.0`, `v2.3.0`],
    halted: `ah1`,
};

const root: RepoSeed = {
    commits: [
        { id: `r1`, subject: `Start the acme-shop workspace`, by: `owner`, hoursAgo: 1000, files: { "README.md": onDisk(`README.md`) } },
        { id: `r2`, subject: `Keep the shop's handover documents in drop/`, by: `agent`, hoursAgo: 90, files: { "drop/brand-kit.zip": BINARY } },
    ],
    head: `main`,
    branches: { main: `r2` },
};

const SHOP_SEEDS = new Map<string, RepoSeed>([
    [`root`, root],
    [`web`, web],
    [`api`, api],
]);

/** The acme-shop recording's history of one repo; undefined for a repo it does not hold. */
export const shopSeed = (repo: string): RepoSeed | undefined => SHOP_SEEDS.get(repo);
