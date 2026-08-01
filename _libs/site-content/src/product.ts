import type { ShotImage } from "./landing";

/* The product pages: one page per surface of the workspace, each carrying real screenshots of that surface.
 *
 * They exist because the landing page can only afford a paragraph per idea, and this product is a UI — the
 * argument for it is the thing itself. Every `src` here is a file the screenshot harness wrote from the demo
 * build (`_tools/e2e/shots/capture.mts`), so a claim on these pages is a screen you can go open in the live
 * demo. Where a surface has no honest screenshot yet, the block carries a DIAGRAM instead — never a mockup
 * of a screen that doesn't exist.
 */

/** How a shot is framed on the page: a browser window, a phone, or the bare image. */
export type ShotFrame = "browser" | "phone" | "bare";

export interface ProductShot extends ShotImage {
    frame: ShotFrame;
    /** The pill in the browser frame's title bar — where in the app this was taken. */
    label?: string;
}

/** A figure drawn in markup rather than screenshotted — the parts of the story that have no single screen. */
export type ProductFigure = "worktrees" | "shared-surfaces" | "integrations" | "triggers" | "ownership" | "platform-boundary";

export interface ProductBlock {
    title: string;
    body: string;
    bullets?: string[];
    shot?: ProductShot;
    figure?: ProductFigure;
}

/** One verifiable number or fact under the hero — never an estimate, never a benchmark we didn't run. */
export interface ProductFact {
    value: string;
    label: string;
}

export interface ProductPage {
    slug: string;
    /** Menu label and page eyebrow. */
    navLabel: string;
    /** The one line of scent under the label in the mega-menu. */
    menuBlurb: string;
    /** Which mega-menu column it belongs to. */
    group: "run" | "environment";
    heading: string;
    sub: string;
    hero: ProductShot;
    facts: ProductFact[];
    blocks: ProductBlock[];
    meta: { title: string; description: string; datePublished: string };
}

export const productHref = (slug: string): string => `/product/${slug}/`;

const PUBLISHED = "2026-08-01";

export const productPages: ProductPage[] = [
    {
        slug: "fleet",
        navLabel: "Fleet board",
        menuBlurb: "Run ten agents at once and see which one needs you",
        group: "run",
        heading: "A board for the whole fleet, sorted by what needs you.",
        sub: "One agent is a chat window. Ten agents need a control surface: who is running, who is blocked on your answer, what each one has changed, and what it has spent. That is the board the workspace opens on.",
        hero: {
            src: "/assets/product/fleet-board.png",
            width: 2144,
            height: 1240,
            alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane where a completed agent offers Land now — every card showing model, branch, tokens, cost and diff stats.",
            frame: "browser",
            label: "acme-shop · /agents",
        },
        facts: [
            { value: "3 lanes", label: "Attention, Active, Finished — the board sorts itself" },
            { value: "1 branch each", label: "every agent works on its own git worktree" },
            { value: "5 harnesses", label: "Claude Code, Codex, Grok, Kimi, Gemini" },
        ],
        blocks: [
            {
                title: "Attention is a lane, not a notification",
                body: "An agent that needs a decision stops and says so. It moves to the Attention lane with the reason on the card — a question, a plan waiting for approval, a land conflict — so a fleet of ten reads as a short list of things only you can do.",
                bullets: [
                    "Question for you · Approval needed · Land conflict — each with the one action that clears it",
                    "Everything else keeps running while you answer",
                ],
            },
            {
                title: "Every card carries the receipts",
                body: "Model and account, branch and base commit, turns and tool calls, tokens in and out, dollars spent, context filled, and the diff it has produced so far. No opening a transcript to find out what an agent has been doing with your money.",
                shot: {
                    src: "/assets/product/mobile-fleet.png",
                    width: 860,
                    height: 1864,
                    alt: "The same fleet board on a phone: agent cards stacked in one column with model, branch, cost and diff stats.",
                    frame: "phone",
                },
            },
            {
                title: "Isolated by construction",
                body: "Each agent gets its own git worktree off your base commit. They never write over each other, and nothing reaches your working tree until you land it — which is what makes running five at once a normal thing to do rather than a gamble.",
                figure: "worktrees",
            },
            {
                title: "Woken by events, not only by you",
                body: "An automation starts an agent on a schedule or an event — a push, an alert, a payment, an email, a Discord message — as a fresh session with its own transcript. The nightly dependency audit on the board arrived that way.",
                figure: "triggers",
            },
        ],
        meta: {
            title: "The fleet board — intentic",
            description:
                "Run ten coding agents at once and see which needs you: attention lanes, per-agent cost and diffs, one git worktree each, woken by schedule or event.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "chat",
        navLabel: "Chat & plan mode",
        menuBlurb: "It proposes, you approve — then it works",
        group: "run",
        heading: "It plans out loud. You decide how far it may go.",
        sub: "Every agent starts in plan mode: it reads first, writes a plan, and waits. You approve the plan and, in the same click, the permission mode it runs under — from approving each edit to letting it run everything.",
        hero: {
            src: "/assets/product/chat-plan.png",
            width: 736,
            height: 1800,
            alt: "The docked chat: the agent's thinking block, a Read tool call, a four-step plan for adding Stripe checkout, and four approval buttons — run everything, auto-accept edits, approve each edit, or keep planning.",
            frame: "bare",
        },
        facts: [
            { value: "4 answers", label: "run everything · auto-accept edits · approve each edit · keep planning" },
            { value: "Per turn", label: "switch model, harness and reasoning effort mid-conversation" },
            { value: "Your account", label: "it runs on your Claude, ChatGPT or xAI subscription" },
        ],
        blocks: [
            {
                title: "The plan is the contract",
                body: "Before it edits anything the agent shows the files it intends to touch and what it will do to each. Reply to revise it. Approve it and the plan becomes the to-do list you watch it work through, step by step.",
                bullets: [
                    "Thinking, tool calls and to-dos stream as they happen — nothing is summarised after the fact",
                    "Steer mid-turn: a message lands in the running turn instead of queuing behind it",
                ],
            },
            {
                title: "Permission is a dial, not a switch",
                body: "The same conversation can be strict on a migration and loose on a changelog. The mode rides with the approval, so you never have to remember what a given agent is allowed to do — you chose it the last time it asked.",
            },
            {
                title: "Bring your own model",
                body: "Claude Code, Codex, Grok, Kimi Code and Gemini, on subscriptions you already pay for. Connect the accounts once in the sandbox; the credential stays there and every turn runs as you, on your plan, at no per-token markup from us.",
                shot: {
                    src: "/assets/product/sandbox-agent.png",
                    width: 2144,
                    height: 720,
                    alt: "The sandbox's Agent tab: a provider row of Claude, ChatGPT, Grok, Kimi Code and Google, with a connected Claude Max account and an Add another account row.",
                    frame: "browser",
                    label: "acme-shop · /sandbox/agent",
                },
            },
            {
                title: "The same conversation on your phone",
                body: "The mobile shell is the same app, not a companion: the running turn, its tool calls, the plan card and the approval buttons — so an agent that stops for a decision at 11pm is one tap from unblocked.",
                shot: {
                    src: "/assets/product/mobile-chat.png",
                    width: 860,
                    height: 1864,
                    alt: "The intentic chat on a phone: a running turn with a thinking block, a Read tool call and the composer, with Agents, Files, Review and Menu tabs along the bottom.",
                    frame: "phone",
                },
            },
        ],
        meta: {
            title: "Chat & plan mode — intentic",
            description:
                "Every agent starts in plan mode: it reads, proposes, and waits for your approval — with the permission mode chosen per approval, on your own model subscription.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "review",
        navLabel: "Review & land",
        menuBlurb: "Read the diff, then land it — or throw it away",
        group: "run",
        heading: "Nothing reaches your tree until you have read the diff.",
        sub: "An agent's work sits on its own branch until you land it. The review panel is the boundary: every changed file, every hunk, the tests it ran — and two buttons, land or discard.",
        hero: {
            src: "/assets/product/agent-review.png",
            width: 2144,
            height: 1800,
            alt: "The isolated review panel: four changed files with per-file line counts, a split diff of a database schema adding a deletedAt column, and a Land now button beside the agent's branch name.",
            frame: "browser",
            label: "acme-shop · agent/soft-deletes",
        },
        facts: [
            { value: "Split or unified", label: "the diff reader you already know, with comments" },
            { value: "Land or discard", label: "one button each — nothing lands by surprise" },
            { value: "Conflicts surface", label: "as an Attention card, with the agent offered the resolve" },
        ],
        blocks: [
            {
                title: "The review boundary is a real branch",
                body: "The agent commits to its worktree; landing replays that delta onto your working tree as ordinary git changes you can still stage, amend or revert. Discarding removes the worktree and leaves your tree untouched.",
                figure: "worktrees",
            },
            {
                title: "Reviewed by file, not by wall of text",
                body: "Files are grouped by repo with their line counts, so a 400-line change reads as six decisions. Comments attach to a hunk, and unread files stay marked until you have looked at them.",
                shot: {
                    src: "/assets/product/workspace-changes.png",
                    width: 2144,
                    height: 1240,
                    alt: "The workspace with a Changes tab showing five uncommitted files and a banner offering to review them before continuing.",
                    frame: "browser",
                    label: "acme-shop · /workspace",
                },
            },
            {
                title: "A conflict is a task, not a dead end",
                body: "When a land collides with work that arrived first, the agent's card moves to Attention with the collision named — and the offer to have the agent resolve it in its own worktree, where a bad merge still cannot touch your tree.",
            },
        ],
        meta: {
            title: "Review & land — intentic",
            description:
                "Every agent works on its own git worktree. Read the diff file by file, comment on a hunk, then land it into your tree or discard it — nothing lands by surprise.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "workspace",
        navLabel: "Workspace & editor",
        menuBlurb: "The IDE surfaces you and the agent share",
        group: "environment",
        heading: "One workspace, two operators.",
        sub: "The file tree, the editor, the search index and the terminal are not a viewer bolted onto a chat — they are the same surfaces the agent works through. You open the file it just wrote from the tree it walked.",
        hero: {
            src: "/assets/product/workspace-editor.png",
            width: 2144,
            height: 940,
            alt: "The intentic workspace: a file tree of two repos on the left and a syntax-highlighted TypeScript schema open in the editor, with a banner offering to review five uncommitted changes.",
            frame: "browser",
            label: "acme-shop · /workspace",
        },
        facts: [
            { value: "One index", label: "`iq` answers your search box and the agent's Bash calls" },
            { value: "One tmux", label: "your terminal and its shell commands share a server" },
            { value: "One tree", label: "what it edits is what you open" },
        ],
        blocks: [
            {
                title: "Shared by construction, not by sync",
                body: "There is one implementation of each surface and two clients for it. Nothing reconciles your view with the agent's, because there are not two views to reconcile — which is why a command it ran is a terminal you can scroll back through.",
                figure: "shared-surfaces",
            },
            {
                title: "Search that reads like an index, not a grep",
                body: 'The workspace search and the agent\'s search are the same `iq` index — lexical, structural and semantic in one query — so "where is the checkout session created" returns the same ranked file:line answers for both of you.',
            },
            {
                title: "Changes you can see before anyone lands anything",
                body: "Uncommitted work in your own tree shows up as a banner and a Changes tab, with the same diff reader the agent review uses. Checkpoints let you rewind the workspace to a known point without leaving the browser.",
                shot: {
                    src: "/assets/product/workspace-changes.png",
                    width: 2144,
                    height: 1240,
                    alt: "The workspace Files tab with the repo tree, a filter box, and tabs for Files, Changes and Checkpoints.",
                    frame: "browser",
                    label: "acme-shop · /workspace",
                },
            },
        ],
        meta: {
            title: "The workspace — intentic",
            description:
                "Editor, file tree, search and terminal — the same surfaces the agent works through, so what it edits is what you open. One index, one tmux, one tree.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "capabilities",
        navLabel: "Capabilities",
        menuBlurb: "Wire the agent to the systems it operates",
        group: "environment",
        heading: "An agent is only as useful as what it can reach.",
        sub: "Capabilities are how a sandbox grows: GitHub, PostgreSQL, Sentry, Stripe, Discord, SSH, a private network, any MCP server. Each one installs a real tool and stores its credential inside your sandbox — never in the platform.",
        hero: {
            src: "/assets/product/capabilities.png",
            width: 2144,
            height: 1800,
            alt: "The capability catalog grouped by Platform, Code & issues, Observability, Data and Communication, with GitHub, Sentry, PostgreSQL, Discord, Docker and SSH marked as connected.",
            frame: "browser",
            label: "acme-shop · /capabilities",
        },
        facts: [
            { value: "25", label: "capabilities and connectors in the catalog today" },
            { value: "0", label: "credentials the platform can read" },
            { value: "Any MCP", label: "server or Claude Code plugin, by URL or git repo" },
        ],
        blocks: [
            {
                title: "Adding one tells you exactly what it will do",
                body: "Before you paste a token the card lists the effects: the skill the agent gains next turn, the environment variable it will be injected under, the image fragment that installs the client. Add it and the agent can use it on its next turn.",
                shot: {
                    src: "/assets/product/capability-github.png",
                    width: 2144,
                    height: 1320,
                    alt: "The GitHub capability: a connected instance, a name field, a personal access token field, a Git access toggle, and a panel listing what it adds to the sandbox — a skill the agent loads next turn and a secret injected into its environment.",
                    frame: "browser",
                    label: "acme-shop · /capabilities/github",
                },
            },
            {
                title: "The credential never leaves the sandbox",
                body: "Secrets are written inside your sandbox and injected into the agent's environment each turn. They are denylisted from the file relay, so they cannot be read out through the workspace — and the platform has no path to them at all.",
                figure: "platform-boundary",
            },
            {
                title: "The systems around one sandbox",
                body: "A specialized agent is usually three or four capabilities away from doing a real job end to end: the repo it works in, the database it reads, the error tracker that pages it, and the chat where its colleagues live.",
                figure: "integrations",
            },
            {
                title: "Events that wake it",
                body: "The same wiring makes agents event-driven. A push, a Sentry alert, a Stripe payment, a new email, a Discord message or plain cron starts a fresh session — optionally gated by a guard command you write.",
                figure: "triggers",
            },
        ],
        meta: {
            title: "Capabilities — intentic",
            description:
                "Wire an agent to GitHub, PostgreSQL, Sentry, Stripe, Discord, SSH or any MCP server. Each capability installs a real tool; the credential never leaves your sandbox.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "sandbox",
        navLabel: "Sandbox & ownership",
        menuBlurb: "The machine, the image and the bill are yours",
        group: "environment",
        heading: "The agent runs on hardware you own.",
        sub: "A sandbox is a Docker container on your laptop, your workstation or your VPS. You can read its image, change what is installed in it, watch what it spends — and the platform stays off the path between your browser and it.",
        hero: {
            src: "/assets/product/sandbox-overview.png",
            width: 2144,
            height: 1440,
            alt: "The sandbox hub: the acme-shop sandbox online with its installed version and URL, and an at-a-glance list of its agent account, secrets, capabilities, running services and access.",
            frame: "browser",
            label: "acme-shop · /sandbox",
        },
        facts: [
            { value: "2 fields", label: "all the platform stores about a sandbox: a name and its URL" },
            { value: "MIT", label: "the sandbox and CLI that run on your machine are open source" },
            { value: "No ports", label: "nothing inbound is opened; the tunnel dials out" },
        ],
        blocks: [
            {
                title: "The image is a file you approve",
                body: "Everything installed beyond the base image is an overlay Dockerfile. The agent may propose a line — a psql client, a browser for the e2e suite — and it waits: you read the diff and approve or reject before a rebuild applies it.",
                shot: {
                    src: "/assets/product/sandbox-environment.png",
                    width: 2144,
                    height: 1300,
                    alt: "The sandbox Environment tab: an overlay Dockerfile diff awaiting review, adding an imagemagick install, with Reject and Approve buttons.",
                    frame: "browser",
                    label: "acme-shop · /sandbox/environment",
                },
            },
            {
                title: "Your browser reaches it directly",
                body: "The sandbox dials out over a private Cloudflare tunnel; your browser talks to that address. The platform issues identity and remembers the URL — it never relays a file, a keystroke or a credential.",
                figure: "ownership",
            },
            {
                title: "The bill is measured where it is spent",
                body: "Every turn's tokens and cost are recorded in the sandbox's own ledger — by day, provider, account and model. It is your subscription being spent, so the numbers live on your machine and the platform never meters them.",
                shot: {
                    src: "/assets/product/sandbox-spend.png",
                    width: 2144,
                    height: 1280,
                    alt: "The sandbox Usage tab: a stacked spend-per-day chart split by Claude Code and Codex, with cost broken down by model and by agent.",
                    frame: "browser",
                    label: "acme-shop · /sandbox/usage",
                },
            },
            {
                title: "What the platform actually holds",
                body: "Identity, the sandbox's URL, billing state, and the grants that let a teammate reach it. Not your code, not your keys, not your transcripts — and what little it does hold is encrypted with no decrypt path in the product.",
                figure: "platform-boundary",
            },
        ],
        meta: {
            title: "Your sandbox — intentic",
            description:
                "Each agent runs in a Docker sandbox on hardware you own: an image overlay you approve, a private tunnel your browser dials, and a spend ledger the platform never sees.",
            datePublished: PUBLISHED,
        },
    },
];

export const productPage = (slug: string): ProductPage | undefined => productPages.find((page) => page.slug === slug);
