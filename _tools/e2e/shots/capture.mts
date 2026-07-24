/* Marketing screenshot harness. Drives the REAL Vue SPA at :47145 with a seeded authenticated session (the
 * e2e cookie recipe) and a fully MOCKED sandbox daemon, so every view renders full, compelling, deterministic
 * content. Not a test — run it by hand (with the dev stack up) to regenerate the product shots under
 * _apps/site/public/assets/product:
 *
 *   LD_LIBRARY_PATH=/tmp/chromelibs/extract/usr/lib node --experimental-strip-types _tools/e2e/shots/capture.mts
 *
 * The platform API (:6480) is the real running dev server — it returns the seeded sandbox (daemonUrl points at
 * the loopback :18787 that nothing serves), so all daemon calls are ours to fulfill. One handler on the daemon
 * origin dispatches by path; unknown paths default to an empty-but-valid 200 so no view errors or hangs. */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@intentic-app/prisma";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import {
    DAEMON_URL,
    DATABASE_URL,
    GOOGLE_TOKEN_STORAGE_KEY,
    SEED,
    SESSION_COOKIE_NAME,
    WEB_URL,
    fakeGoogleIdToken,
    seed,
    signedSessionCookie,
} from "../stack.ts";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const OUT_DIR = resolve(import.meta.dirname, "../../../_apps/site/public/assets/product");
const NOW = Date.now();
const ago = (ms: number): number => NOW - ms;
const SANDBOX_NAME = "release-captain";

// ── canned daemon world — one coherent "release-captain" sandbox across every view ───────────────────────

const base = "39ce039";
const agent = (o: Record<string, unknown>): Record<string, unknown> => ({
    provider: "claude",
    harness: "claude-code",
    account: "Claude Max",
    base,
    attention: { plan: false, question: false, conflict: false },
    updatedAt: NOW,
    ...o,
});

const AGENTS = [
    agent({
        id: "a-billing",
        title: "Add Stripe metered billing to the checkout flow",
        status: "awaiting",
        model: "claude-opus-4-8",
        branch: "agent/a-billing",
        attention: { plan: true, question: false, conflict: false },
        costUsd: 1.84,
        inputTokens: 184_000,
        outputTokens: 12_400,
        contextTokens: 84_000,
        contextWindow: 200_000,
        updatedAt: ago(40_000),
        turns: 12,
        toolUses: 47,
        diff: { files: 9, insertions: 412, deletions: 96 },
    }),
    agent({
        id: "a-auth",
        title: "Fix the OAuth redirect loop on expired sessions",
        status: "awaiting",
        provider: "codex",
        harness: "native",
        account: "ChatGPT",
        model: "gpt-5.1-codex",
        branch: "agent/a-auth",
        attention: { plan: false, question: true, conflict: false },
        costUsd: 0.42,
        contextTokens: 31_000,
        contextWindow: 400_000,
        updatedAt: ago(120_000),
        turns: 5,
        toolUses: 18,
        diff: { files: 3, insertions: 88, deletions: 21 },
    }),
    agent({
        id: "a-migrate",
        title: "Migrate the reporting queries to the read replica",
        status: "running",
        model: "claude-sonnet-5",
        branch: "agent/a-migrate",
        costUsd: 0.91,
        contextTokens: 52_000,
        contextWindow: 200_000,
        startedAt: ago(26_000),
        updatedAt: ago(2_000),
        turns: 8,
        toolUses: 33,
        activity: { tool: "Bash", target: "pnpm test reporting", todo: "Run the reporting suite against the replica" },
        diff: { files: 6, insertions: 174, deletions: 40 },
    }),
    agent({
        id: "a-grok",
        title: "Draft the changelog for the 2.4 release",
        status: "running",
        provider: "grok",
        harness: "native",
        account: "xAI",
        model: "grok-4",
        branch: "agent/a-grok",
        costUsd: 0.12,
        contextTokens: 12_000,
        contextWindow: 256_000,
        startedAt: ago(8_000),
        updatedAt: ago(1_000),
        turns: 3,
        toolUses: 9,
        activity: { tool: "Read", target: "CHANGELOG.md", todo: "Summarize the merged PRs since 2.3" },
        diff: { files: 1, insertions: 63, deletions: 4 },
    }),
    agent({
        id: "a-triage",
        title: "Triage the Sentry spike in the upload worker",
        status: "landed",
        model: "claude-opus-4-8",
        branch: "agent/a-triage",
        costUsd: 2.31,
        updatedAt: ago(900_000),
        turns: 15,
        toolUses: 61,
        diff: { files: 4, insertions: 120, deletions: 210 },
    }),
    agent({
        id: "a-docs",
        title: "Document the capabilities catalog in the README",
        status: "landed",
        provider: "codex",
        harness: "native",
        account: "ChatGPT",
        model: "gpt-5.1",
        branch: "agent/a-docs",
        costUsd: 0.28,
        updatedAt: ago(3_600_000),
        turns: 4,
        toolUses: 12,
        diff: { files: 2, insertions: 96, deletions: 8 },
    }),
];

const acc = (id: string, label: string) => ({ id, label, connectedAt: ago(8.64e7) });
const ACCOUNTS: Record<string, unknown> = {
    claude: { accounts: [acc("claude-1", "Claude Max")] },
    grok: { accounts: [acc("grok-1", "xAI · SuperGrok")] },
};
const MODELS: Record<string, unknown> = {
    claude: {
        models: [
            { id: "claude-opus-4-8", label: "Opus 4.8" },
            { id: "claude-sonnet-5", label: "Sonnet 5" },
            { id: "claude-haiku-4-5", label: "Haiku 4.5" },
        ],
        default: "claude-opus-4-8",
    },
    codex: { models: [{ id: "gpt-5.1", label: "GPT-5.1" }, { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" }], default: "gpt-5.1" },
    grok: { models: [{ id: "grok-4", label: "Grok 4" }, { id: "grok-4-fast", label: "Grok 4 Fast" }], default: "grok-4" },
};

const DIFF = {
    repos: [
        {
            repo: "root",
            branch: "agent/a-billing",
            changes: [
                { path: "api/src/billing/stripe.ts", status: "added", additions: 168, deletions: 0 },
                { path: "api/src/billing/checkout.ts", status: "modified", additions: 94, deletions: 31 },
                { path: "api/src/billing/webhook.ts", status: "added", additions: 76, deletions: 0 },
                { path: "web/src/pages/Upgrade.vue", status: "modified", additions: 58, deletions: 12 },
                { path: "prisma/schema.prisma", status: "modified", additions: 14, deletions: 2 },
                { path: "package.json", status: "modified", additions: 2, deletions: 1 },
            ],
        },
    ],
};

const CHECKOUT_TS = `import Stripe from "stripe";
import { stripe } from "./stripe";
import { db } from "../db";

// Create a metered checkout session for the signed-in account. The price is a
// usage-based Stripe price; quantity is reported per billing period by the webhook.
export const createCheckoutSession = async (accountId: string): Promise<{ url: string }> => {
    const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
    const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: account.stripeCustomerId,
        line_items: [{ price: process.env.STRIPE_METERED_PRICE }],
        success_url: \`\${process.env.APP_URL}/upgrade/done\`,
        cancel_url: \`\${process.env.APP_URL}/upgrade\`,
    });
    return { url: session.url };
};
`;

const TREE = {
    root: "/work",
    truncated: false,
    tree: [
        {
            name: "api",
            path: "api",
            type: "dir",
            children: [
                {
                    name: "src",
                    path: "api/src",
                    type: "dir",
                    children: [
                        {
                            name: "billing",
                            path: "api/src/billing",
                            type: "dir",
                            children: [
                                { name: "checkout.ts", path: "api/src/billing/checkout.ts", type: "file", size: 1120 },
                                { name: "stripe.ts", path: "api/src/billing/stripe.ts", type: "file", size: 640 },
                                { name: "webhook.ts", path: "api/src/billing/webhook.ts", type: "file", size: 820 },
                            ],
                        },
                        { name: "db.ts", path: "api/src/db.ts", type: "file", size: 410 },
                        { name: "index.ts", path: "api/src/index.ts", type: "file", size: 2410 },
                    ],
                },
                { name: "package.json", path: "api/package.json", type: "file", size: 812 },
            ],
        },
        {
            name: "web",
            path: "web",
            type: "dir",
            children: [
                {
                    name: "src",
                    path: "web/src",
                    type: "dir",
                    children: [
                        { name: "pages", path: "web/src/pages", type: "dir", children: [{ name: "Upgrade.vue", path: "web/src/pages/Upgrade.vue", type: "file", size: 1980 }] },
                        { name: "App.vue", path: "web/src/App.vue", type: "file", size: 1980 },
                    ],
                },
            ],
        },
        { name: "prisma", path: "prisma", type: "dir", children: [{ name: "schema.prisma", path: "prisma/schema.prisma", type: "file", size: 3200 }] },
        { name: "README.md", path: "README.md", type: "file", size: 640 },
        { name: "package.json", path: "package.json", type: "file", size: 980 },
        { name: "node_modules", path: "node_modules", type: "dir", ignored: true },
    ],
};

const CAPABILITIES = {
    capabilities: [
        { id: "github", kind: "service", status: { state: "active" }, config: { org: "acme" } },
        { id: "postgres", kind: "docker", status: { state: "active" }, config: { image: "postgres:16", port: 5432 } },
        { id: "sentry", kind: "service", status: { state: "active" }, config: { project: "acme-api" } },
        { id: "stripe", kind: "service", status: { state: "active" }, config: {} },
        { id: "discord", kind: "service", status: { state: "active" }, config: { guild: "acme" } },
    ],
};

// The live-turn transcript the docked chat / mobile chat renders (POST /agent/attach, SSE AttachFrames). A
// completed read+edit sequence that ends paused on a plan card — matching a-billing's "awaiting" status.
const attachFrames = (): unknown[] => {
    let seq = 0;
    const f = (event: unknown): unknown => ({ kind: "frame", seq: ++seq, event });
    return [
        { kind: "attached", run: "run-1", prompt: "Add Stripe metered billing to the checkout flow", startedAt: ago(60_000), seq: 0 },
        f({ kind: "init", model: "claude-opus-4-8" }),
        f({ kind: "worktree", branch: "agent/a-billing", base }),
        f({ kind: "delta", text: "I'll wire metered Stripe billing into the checkout flow. First, let me see how checkout works today.\n\n" }),
        f({
            kind: "tool_call",
            id: "t1",
            name: "Read",
            category: "read",
            status: "completed",
            target: "api/src/billing/checkout.ts",
            locations: [{ path: "api/src/billing/checkout.ts", line: 1 }],
        }),
        f({
            kind: "tool_call",
            id: "t2",
            name: "Bash",
            category: "execute",
            status: "completed",
            target: "rg -n 'STRIPE_' api/src",
        }),
        f({
            kind: "todos",
            items: [
                { content: "Add a Stripe client + metered price", status: "completed", activeForm: "Adding the Stripe client" },
                { content: "Create the checkout session", status: "in_progress", activeForm: "Creating the checkout session" },
                { content: "Handle the usage webhook", status: "pending", activeForm: "Handling the usage webhook" },
            ],
        }),
        f({
            kind: "tool_call",
            id: "t3",
            name: "Edit",
            category: "edit",
            status: "completed",
            target: "api/src/billing/checkout.ts",
            content: [
                {
                    type: "diff",
                    path: "api/src/billing/checkout.ts",
                    oldText: "const session = await stripe.checkout.sessions.create({\n    mode: \"subscription\",\n    customer: account.stripeCustomerId,\n});",
                    newText:
                        "const session = await stripe.checkout.sessions.create({\n    mode: \"subscription\",\n    customer: account.stripeCustomerId,\n    line_items: [{ price: process.env.STRIPE_METERED_PRICE }],\n    success_url: `${process.env.APP_URL}/upgrade/done`,\n});",
                },
            ],
        }),
        f({
            kind: "delta",
            text:
                "Checkout now opens a metered subscription. Next I'll add `api/src/billing/webhook.ts` to record usage each period, add a `MeteredUsage` model, and update the Upgrade page — then wire up tests.",
        }),
        f({ kind: "done" }),
        { kind: "end" },
    ];
};

const sse = (frames: unknown[]) => ({
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
});
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const emptyFor = (path: string): unknown => {
    if (path.includes("automations")) return { automations: [] };
    if (path.includes("secrets")) return { secrets: [] };
    if (path.includes("extensions")) return { extensions: [] };
    if (path.includes("presence")) return { users: [] };
    if (path.includes("sessions")) return { sessions: [] };
    if (path.endsWith("/usage")) return { accounts: [] };
    return {};
};

const fulfillDaemon = async (route: Route): Promise<void> => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const provider = (): string => (path.includes("claude") ? "claude" : path.includes("codex") ? "codex" : "grok");

    if (path.startsWith("/events")) return route.fulfill(sse([{ kind: "hello", workspaceId: "ws-release-captain" }, { kind: "agents", agents: AGENTS }, { kind: "heartbeat" }]));
    if (path === "/agent/attach") return route.fulfill(sse(attachFrames()));
    if (path === "/agent" && req.method() === "POST") return route.fulfill(json({ run: "run-1" }));
    if (path === "/agents") return route.fulfill(json({ agents: AGENTS }));
    if (path.endsWith("/diff") && path.startsWith("/agents/")) return route.fulfill(json(DIFF));
    if (path.includes("/file-diff")) return route.fulfill(json({ before: CHECKOUT_TS, after: CHECKOUT_TS }));
    if (path.endsWith("/accounts") && (path.includes("claude") || path.includes("grok"))) return route.fulfill(json(ACCOUNTS[provider()]));
    if (path.endsWith("/models")) return route.fulfill(json(MODELS[provider()]));
    if (path === "/translator/accounts") return route.fulfill(json({ codex: true, grok: true }));
    if (path === "/workspace/tree") return route.fulfill(json(TREE));
    if (path === "/workspace/file") return route.fulfill(json({ content: CHECKOUT_TS }));
    if (path === "/panels") return route.fulfill(json({ panels: [] }));
    if (path === "/capabilities") return route.fulfill(json(CAPABILITIES));
    if (path === "/info") return route.fulfill(json({ name: SANDBOX_NAME, image: "registry.gitlab.com/acme/sandbox:stable", version: "2026.7.1", latest: "2026.7.1", updateAvailable: false }));
    if (path === "/environment") return route.fulfill(json({ container: `intentic-sandbox-${SANDBOX_NAME}` }));
    return route.fulfill(json(emptyFor(path)));
};

// Rename the seeded sandbox so every view reads "release-captain" instead of "E2E Sandbox".
const renameSandbox = async (): Promise<void> => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
    try {
        await prisma.sandbox.update({ where: { id: SEED.sandboxId }, data: { name: SANDBOX_NAME } });
    } finally {
        await prisma.$disconnect();
    }
};

// ── shots ────────────────────────────────────────────────────────────────────────────────────────────────

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 430, height: 932 };

interface Shot {
    name: string;
    path: string;
    mobile?: boolean;
    waitFor?: string;
    settleMs?: number;
    clipBoard?: boolean; // clip off the empty docked chat on the right
    clipH?: number; // crop height (CSS px) to trim empty canvas below the content
}

const SHOTS: Shot[] = [
    { name: "agents-fleet", path: "/agents", waitFor: "text=Add Stripe metered billing", settleMs: 900, clipBoard: true, clipH: 470 },
    { name: "agent-review", path: "/agents/a-billing", waitFor: "text=not yet landed", settleMs: 2600 },
    { name: "chat", path: "/agents/a-billing", mobile: true, settleMs: 2800 },
    { name: "workspace", path: "/workspace/api/src/billing/checkout.ts", waitFor: 'textarea[name="draft"]', settleMs: 1400, clipBoard: true },
    { name: "capabilities", path: "/capabilities", waitFor: "text=Add a capability", settleMs: 1000, clipBoard: true },
    { name: "sandbox", path: "/sandbox", waitFor: `text=${SANDBOX_NAME}`, settleMs: 1000, clipBoard: true },
];

const boardClip = async (page: Page, clipH?: number): Promise<{ x: number; y: number; width: number; height: number }> => {
    const box = await page.locator('textarea[name="draft"]').boundingBox().catch(() => null);
    const height = clipH ?? page.viewportSize()?.height ?? DESKTOP.height;
    return { x: 0, y: 0, width: box ? Math.round(box.x - 26) : 1080, height };
};

const run = async (): Promise<void> => {
    mkdirSync(OUT_DIR, { recursive: true });
    const { sessionToken } = await seed();
    await renameSandbox();
    const cookieValue = signedSessionCookie(sessionToken);

    const browser: Browser = await chromium.launch();

    const shoot = async (context: BrowserContext, shot: Shot): Promise<void> => {
        await context.addCookies([
            { name: SESSION_COOKIE_NAME, value: cookieValue, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
        ]);
        await context.addInitScript(([key, token]) => window.localStorage.setItem(key, token), [GOOGLE_TOKEN_STORAGE_KEY, fakeGoogleIdToken()] as const);
        await context.route(`${DAEMON_URL}/**`, fulfillDaemon);
        const page = await context.newPage();
        page.on("pageerror", (e) => console.warn(`  [pageerror ${shot.name}] ${e.message.split("\n")[0]}`));
        try {
            await page.goto(`${WEB_URL}${shot.path}`, { waitUntil: "domcontentloaded" });
            if (shot.waitFor) await page.waitForSelector(shot.waitFor, { timeout: 20_000 }).catch(() => console.warn(`  [no waitFor ${shot.name}]`));
            await page.waitForTimeout(shot.settleMs ?? 800);
            const clip = shot.clipBoard ? await boardClip(page, shot.clipH) : undefined;
            await page.screenshot({ path: resolve(OUT_DIR, `${shot.name}.png`), clip });
            console.log(`  ✓ ${shot.name} -> ${shot.path}`);
        } catch (e) {
            console.error(`  ✗ ${shot.name}:`, (e as Error).message.split("\n")[0]);
        } finally {
            await page.close();
        }
    };

    for (const shot of SHOTS) {
        const context = await browser.newContext({
            viewport: shot.mobile ? MOBILE : DESKTOP,
            deviceScaleFactor: 2,
            isMobile: shot.mobile ?? false,
            hasTouch: shot.mobile ?? false,
            ignoreHTTPSErrors: true,
            colorScheme: "dark",
        });
        await shoot(context, shot);
        await context.close();
    }
    await browser.close();
};

await run();
