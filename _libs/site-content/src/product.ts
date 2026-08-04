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
export type ProductFigure =
    | "worktrees"
    | "shared-surfaces"
    | "integrations"
    | "triggers"
    | "ownership"
    | "platform-boundary"
    | "prompt-vs-environment"
    | "sharing"
    | "teammate";

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
    /**
     * Which mega-menu column it belongs to. `extend` is the column for surfaces that are not part of
     * the core loop — the ones that answer "what else can it do" rather than "what is it". Keeping
     * Doorbell out of `run` is the nav half of the same decision the landing page makes: a support
     * widget and a fleet of coding agents are bought by different people.
     */
    group: "run" | "environment" | "extend";
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
        sub: "One agent is a chat window. Ten need a control surface: who is running, who is blocked, what each has changed and spent.",
        hero: {
            name: "fleet-board",
            alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane where a completed agent offers Land now. Every card shows model, branch, tokens, cost and diff stats.",
            frame: "browser",
            label: "acme-shop · /agents",
        },
        facts: [
            { value: "3 lanes", label: "Attention, Active, Finished. The board sorts itself" },
            { value: "1 branch each", label: "every agent works on its own git worktree" },
            { value: "5 harnesses", label: "Claude Code, Codex, Grok, Kimi, Gemini" },
        ],
        blocks: [
            {
                title: "Attention is a lane, not a notification",
                body: "An agent that needs a decision stops and says so, with the reason on its card. A fleet of ten reads as a short list of things only you can do.",
                bullets: [
                    "Question for you · Approval needed · Land conflict, each with the one action that clears it",
                    "Everything else keeps running while you answer",
                ],
            },
            {
                title: "Every card carries the receipts",
                body: "Model, branch, turns, tokens in and out, dollars spent, and the diff so far. No opening a transcript to find out where your money went.",
                shot: {
                    name: "mobile-fleet",
                    alt: "The same fleet board on a phone: agent cards stacked in one column with model, branch, cost and diff stats.",
                    frame: "phone",
                },
            },
            {
                title: "Isolated by construction",
                body: "Each agent gets its own git worktree off your base commit. They never write over each other, and nothing reaches your tree until you land it.",
                figure: "worktrees",
            },
            {
                title: "Woken by events, not only by you",
                body: "An automation starts an agent on a schedule or an event, as a fresh session with its own transcript. The nightly dependency audit arrived that way.",
                figure: "triggers",
            },
        ],
        meta: {
            title: "The fleet board · intentic",
            description:
                "Run ten coding agents at once and see which needs you: attention lanes, per-agent cost and diffs, one git worktree each, woken by schedule or event.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "chat",
        navLabel: "Chat & plan mode",
        menuBlurb: "It proposes, you approve, then it works",
        group: "run",
        heading: "It plans out loud. You approve once, then it works.",
        sub: "Every agent starts in plan mode: it reads, writes a plan, and waits. Approve it and the agent runs the whole plan — it works in a container of its own, so it never stops to ask the same yes twice.",
        hero: {
            name: "chat-plan",
            alt: "The docked chat: the agent's thinking block, a Read tool call, a four-step plan for adding Stripe checkout, and two buttons: approve, or keep planning.",
            frame: "bare",
        },
        facts: [
            { value: "2 answers", label: "approve the plan · or reply to keep planning" },
            { value: "Per turn", label: "switch model, harness and reasoning effort mid-conversation" },
            { value: "Your account", label: "it runs on your Claude, ChatGPT or xAI subscription" },
        ],
        blocks: [
            {
                title: "The plan is the contract",
                body: "Before it edits anything, the agent shows which files it will touch and what it will do to each. Approve it and the plan becomes a to-do list you watch.",
                bullets: [
                    "Thinking, tool calls and to-dos stream as they happen, never summarised after the fact",
                    "Steer mid-turn: a message lands in the running turn instead of queuing behind it",
                ],
            },
            {
                title: "Permission is a dial, not a switch",
                body: "The same conversation can be strict on a migration and loose on a changelog — the composer's mode pill sets how much the agent may do unattended, per turn. An approved plan is the exception: you have read what it intends, so it runs the lot.",
            },
            {
                title: "Bring your own model",
                body: "Claude Code, Codex, Grok, Kimi Code and Gemini, on subscriptions you already pay for. Connect once; the credential stays in the sandbox and every turn runs on your plan.",
                shot: {
                    name: "sandbox-agent",
                    alt: "The sandbox's Agent tab: a provider row of Claude, ChatGPT, Grok, Kimi Code and Google, with a connected Claude Max account and an Add another account row.",
                    frame: "browser",
                    label: "acme-shop · /sandbox/agent",
                },
            },
            {
                title: "The same conversation on your phone",
                body: "The mobile shell is the same app, not a companion. An agent that stops for a decision at 11pm is one tap from unblocked.",
                shot: {
                    name: "mobile-chat",
                    alt: "The intentic chat on a phone: a running turn with a thinking block, a Read tool call and the composer, with Agents, Files, Review and Menu tabs along the bottom.",
                    frame: "phone",
                },
            },
        ],
        meta: {
            title: "Chat & plan mode · intentic",
            description:
                "Every agent starts in plan mode: it reads, proposes, and waits for your approval — then runs the plan it showed you, on your own model subscription.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "review",
        navLabel: "Review & land",
        menuBlurb: "Read the diff, then land it or throw it away",
        group: "run",
        heading: "Nothing reaches your tree until you have read the diff.",
        sub: "An agent's work sits on its own branch until you land it. The review panel shows every changed file, every hunk, the tests it ran, and two buttons.",
        hero: {
            name: "agent-review",
            alt: "The isolated review panel: four changed files with per-file line counts, a split diff of a database schema adding a deletedAt column, and a Land now button beside the agent's branch name.",
            frame: "browser",
            label: "acme-shop · agent/soft-deletes",
        },
        facts: [
            { value: "Split or unified", label: "the diff reader you already know, with comments" },
            { value: "Land or discard", label: "one button each; nothing lands by surprise" },
            { value: "Conflicts surface", label: "as an Attention card, with the agent offered the resolve" },
        ],
        blocks: [
            {
                title: "The review boundary is a real branch",
                body: "Landing replays the agent's delta onto your tree as ordinary git changes you can stage, amend or revert. Discarding removes the worktree and leaves your tree untouched.",
                figure: "worktrees",
            },
            {
                title: "Reviewed by file, not by wall of text",
                body: "Files are grouped by repo with their line counts, so a 400-line change reads as six decisions. Comments attach to a hunk, and unread files stay marked until you have looked at them.",
                shot: {
                    name: "workspace-changes",
                    alt: "The workspace Changes tab: five uncommitted files grouped by repo with their line counts, and the diff of one of them open beside the list.",
                    frame: "browser",
                    label: "acme-shop · /workspace",
                },
            },
            {
                title: "A conflict is a task, not a dead end",
                body: "When a land collides with work that arrived first, the card moves to Attention and the agent offers to resolve it in its own worktree.",
            },
        ],
        meta: {
            title: "Review & land · intentic",
            description:
                "Every agent works on its own git worktree. Read the diff file by file, comment on a hunk, then land it into your tree or discard it. Nothing lands by surprise.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "workspace",
        navLabel: "Workspace & editor",
        menuBlurb: "The IDE surfaces you and the agent share",
        group: "environment",
        heading: "One workspace, two operators.",
        sub: "The file tree, editor, search index and terminal are not a viewer bolted onto a chat. They are the same surfaces the agent works through.",
        hero: {
            name: "workspace-editor",
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
                body: "One implementation of each surface, two clients for it. Nothing reconciles your view with the agent's, because there are not two views to reconcile.",
                figure: "shared-surfaces",
            },
            {
                title: "Search that reads like an index, not a grep",
                body: 'Your search box and the agent\'s search are the same `iq` index, so "where is the checkout session created" returns the same ranked answers for both of you.',
            },
            {
                title: "Changes you can see before anyone lands anything",
                body: "Uncommitted work in your own tree shows up as a banner and a Changes tab, with the same diff reader the review uses. Checkpoints rewind to a known point.",
                shot: {
                    name: "workspace-changes",
                    alt: "The workspace Changes tab with a banner offering review before continuing, five uncommitted files, and a split diff of checkout.ts.",
                    frame: "browser",
                    label: "acme-shop · /workspace",
                },
            },
        ],
        meta: {
            title: "The workspace · intentic",
            description:
                "Editor, file tree, search and terminal: the same surfaces the agent works through, so what it edits is what you open. One index, one tmux, one tree.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "capabilities",
        navLabel: "Capabilities",
        menuBlurb: "Wire the agent to the systems it operates",
        group: "environment",
        heading: "An agent is only as useful as what it can reach.",
        sub: "Capabilities are how a sandbox grows: GitHub, PostgreSQL, Sentry, Stripe, Discord, SSH, any MCP server. Each installs a real tool and keeps its credential in your sandbox.",
        hero: {
            name: "capabilities",
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
                body: "Before you paste a token, the card lists the effects: the skill the agent gains, the variable it lands in, the image fragment that installs the client.",
                shot: {
                    name: "capability-github",
                    alt: "The GitHub capability: a connected instance, a name field, a personal access token field, a Git access toggle, and a panel listing what it adds to the sandbox: a skill the agent loads next turn and a secret injected into its environment.",
                    frame: "browser",
                    label: "acme-shop · /capabilities/github",
                },
            },
            {
                title: "The credential never leaves the sandbox",
                body: "Secrets are written inside your sandbox and injected each turn. They are denylisted from the file relay, and the platform has no path to them at all.",
                figure: "platform-boundary",
            },
            {
                title: "The systems around one sandbox",
                body: "A specialized agent is three or four capabilities from doing a real job: the repo, the database, the error tracker, the chat where its colleagues live.",
                figure: "integrations",
            },
            {
                title: "Talk to it where your team already works",
                body: "Connect Discord or Slack and the agent joins as a real participant. Assign work with an @mention; it plans, executes and reports back in the same thread.",
                figure: "teammate",
            },
            {
                title: "Events that wake it",
                body: "The same wiring makes agents event-driven. A push, an alert, a payment, an email or plain cron starts a fresh session, gated by a guard command you write.",
                figure: "triggers",
            },
        ],
        meta: {
            title: "Capabilities · intentic",
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
        sub: "A sandbox is a Docker container on your laptop, workstation or VPS. Read its image, change what is installed, watch what it spends.",
        hero: {
            name: "sandbox-overview",
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
                body: "Everything past the base image is an overlay Dockerfile. The agent can propose a line and then waits: you read the diff and approve before a rebuild applies it.",
                shot: {
                    name: "sandbox-environment",
                    alt: "The sandbox Environment tab: an overlay Dockerfile diff awaiting review, adding an imagemagick install, with Reject and Approve buttons.",
                    frame: "browser",
                    label: "acme-shop · /sandbox/environment",
                },
            },
            {
                title: "Your browser reaches it directly",
                body: "The sandbox dials out over a private Cloudflare tunnel and your browser talks to that address. The platform never relays a file, a keystroke or a credential.",
                figure: "ownership",
            },
            {
                title: "The bill is measured where it is spent",
                body: "Every turn's tokens and cost land in the sandbox's own ledger, by day, provider and model. It is your subscription, so the platform never meters it.",
                shot: {
                    name: "sandbox-spend",
                    alt: "The sandbox Usage tab: a stacked spend-per-day chart split by Claude Code and Codex, with cost broken down by model and by agent.",
                    frame: "browser",
                    label: "acme-shop · /sandbox/usage",
                },
            },
            {
                title: "What the platform actually holds",
                body: "Identity, the sandbox's URL, billing state, and the grants that let a teammate reach it. Not your code, not your keys, not your transcripts.",
                figure: "platform-boundary",
            },
            {
                title: "Everyone else lets you edit the prompt",
                body: "The prompt is the one layer you can change anywhere. A sandbox opens the rest: the image, the systems it reaches, the skills it loads every turn. You can't make the model smarter, only better equipped.",
                figure: "prompt-vs-environment",
            },
            {
                title: "One sandbox, several people",
                body: "The owner installs the tools; invited teammates share that same sandbox, each over their own private tunnel. Setup stays owner-gated.",
                bullets: [
                    "Invite by email; grants are enforced by the daemon, fail-closed.",
                    "Teammates chat, drive and review, and mirror the sandbox's ports.",
                    "Sharing is a Pro feature; revoking or leaving never is.",
                ],
                figure: "sharing",
            },
        ],
        meta: {
            title: "Your sandbox · intentic",
            description:
                "Each agent runs in a Docker sandbox on hardware you own: an image overlay you approve, a private tunnel your browser dials, and a spend ledger the platform never sees.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "doorbell",
        navLabel: "Doorbell",
        menuBlurb: "Put your agent on your own website",
        group: "extend",
        heading: "Your agent, answering on your own website.",
        sub: "One script tag puts a chat bubble on your site. The thing answering is the same agent that has your repo, your docs and your tools. Every conversation opens on your fleet board.",
        hero: {
            name: "doorbell",
            alt: "A robotics company's website with the Doorbell widget open in the corner: the agent greets the visitor, the visitor asks whether the arms work outdoors, and the agent answers with the IP66 rating and a cold-weather caveat, then offers to open a ticket.",
            frame: "browser",
            label: "a customer's site",
        },
        facts: [
            { value: "1", label: "script tag to install" },
            { value: "6 kB", label: "gzipped, no framework" },
            { value: "read-only", label: "toolbox by default" },
        ],
        blocks: [
            {
                title: "One line, and the address is already right",
                body: "The snippet carries one piece of information: which automation to talk to. No second address to keep in sync, and no key sitting in your page's source.",
                bullets: [
                    "Renders in a shadow root: your CSS cannot reshape it, its CSS cannot leak into your page.",
                    "An allowlist of your own origins decides who may embed it.",
                    "The install panel tells you which sites have loaded it, and which were turned away.",
                ],
            },
            {
                title: "A conversation, not a series of strangers",
                body: "A follow-up continues the same thread rather than meeting the visitor again. One visitor is one card on your fleet board: open it, read it, answer in your own words.",
                figure: "shared-surfaces",
            },
            {
                title: "Safe to point at the open internet",
                body: "A Doorbell is driven by strangers, so it runs a read-only toolbox: read, search, fetch, and nothing else. That is a list of allowed tools, not a request in the prompt.",
                bullets: [
                    "Each visitor thread runs in its own throwaway git worktree.",
                    "A bot check per conversation: Cloudflare Turnstile, or a built-in one that needs no accounts.",
                    "Optional Google sign-in against your own OAuth client; the visitor never holds a credential for your sandbox.",
                    "Per-conversation rate limits and a daily ceiling you set.",
                ],
            },
        ],
        meta: {
            title: "Doorbell · put your agent on your website · intentic",
            description:
                "Embed a chat on your site with one script tag. Visitors talk to your sandbox agent; each thread opens on your fleet board for you to watch and take over.",
            datePublished: PUBLISHED,
        },
    },
];

export const productPage = (slug: string): ProductPage | undefined => productPages.find((page) => page.slug === slug);
