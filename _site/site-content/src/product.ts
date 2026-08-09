import type { ShotImage } from "./landing";

/* The feature pages: one page per VERB — what you do with the workspace, not what a surface is called.
 *
 * The shelf used to list surfaces (Fleet board, Chat & plan mode, Review & land, the editor…), and half of
 * those read as table stakes any agentic editor has, so the menu undersold the product. It now names five
 * outcomes — Orchestrate, Empower, Automate, Supervise, Delegate — and each page folds the relevant surfaces
 * underneath it as proof. See docs/marketing/landing-blueprint.md ("The feature pages") for the mapping.
 *
 * Every `src` here is still a file the screenshot harness wrote from the demo build
 * (`_tools/e2e/shots/capture.mts`), so a claim on these pages is a screen you can open in the live demo.
 * Where a surface has no honest screenshot yet, the page carries a DIAGRAM instead — never a mockup of a
 * screen that doesn't exist. Automate has no captured screen at all, so it is diagram-led: its hero is the
 * triggers figure, not an invented UI.
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
    /** Menu label and page eyebrow — the verb. */
    navLabel: string;
    /** The one line of scent under the label in the mega-menu. */
    menuBlurb: string;
    heading: string;
    sub: string;
    /**
     * The hero visual. A page leads with a real screenshot (`hero`) OR, where the surface has no honest
     * screenshot, a diagram (`heroFigure`) — exactly one is set. Automate is the only diagram-led page:
     * there is no captured automations screen, and a mockup would be the one lie on the shelf.
     */
    hero?: ProductShot;
    heroFigure?: ProductFigure;
    facts: ProductFact[];
    blocks: ProductBlock[];
    meta: { title: string; description: string; datePublished: string };
}

export const productHref = (slug: string): string => `/product/${slug}/`;

const PUBLISHED = "2026-08-09";

export const productPages: ProductPage[] = [
    {
        slug: "orchestrate",
        navLabel: "Orchestrate",
        menuBlurb: "Run ten agents at once and see which one needs you",
        heading: "Run the whole fleet. Get pulled in only when one needs you.",
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
            { value: "5 agents", label: "Claude Code, Codex, Grok, Kimi Code, Google" },
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
        ],
        meta: {
            title: "Orchestrate · intentic",
            description:
                "Run ten coding agents at once and see which needs you: attention lanes, per-agent cost and diffs, one git worktree each, the whole fleet on one board.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "empower",
        navLabel: "Empower",
        menuBlurb: "Wire agents into your systems — they see and act",
        heading: "An agent is only as useful as what it can reach.",
        sub: "Capabilities are how a sandbox grows: GitHub, PostgreSQL, Sentry, Stripe, Discord, SSH, any MCP server. Each installs a real tool and keeps its credential in your sandbox — and one puts the agent on your own website.",
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
                body: "A specialized agent is three or four capabilities from doing a real job: the repo, the database, the error tracker, the CI and deploys, the chat where its colleagues live.",
                figure: "integrations",
            },
            {
                title: "Talk to it where your team already works",
                body: "Connect Discord or Slack and the agent joins as a real participant. Assign work with an @mention; it plans, executes and reports back in the same thread.",
                figure: "teammate",
            },
            {
                title: "Put it on your own website",
                body: "One script tag drops a chat bubble on your site, answered by the same agent that has your repo, your docs and your tools. Every conversation opens on your fleet board for you to watch or take over.",
                bullets: [
                    "A read-only toolbox by default: it can read, search and fetch, nothing else.",
                    "Each visitor thread runs in its own throwaway git worktree, behind a bot check.",
                ],
                shot: {
                    name: "doorbell",
                    alt: "A robotics company's website with the Doorbell widget open in the corner: the agent greets the visitor, the visitor asks whether the arms work outdoors, and the agent answers with the IP66 rating and a cold-weather caveat, then offers to open a ticket.",
                    frame: "browser",
                    label: "a customer's site",
                },
            },
        ],
        meta: {
            title: "Empower · intentic",
            description:
                "Wire an agent to GitHub, PostgreSQL, Sentry, Stripe, Discord, SSH, CI/CD or any MCP server — and onto your own website. Each capability installs a real tool; the credential never leaves your sandbox.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "automate",
        navLabel: "Automate",
        menuBlurb: "Agents that start themselves on an event, and act",
        heading: "Agents that start themselves — on a schedule, or an event.",
        sub: "An automation wakes an agent under permissions you set: a push, an alert, a payment, an email, a chat message, or plain cron. A guard command you write decides whether each wake runs, and every run is a fresh session you can watch.",
        // Diagram-led: there is no captured automations screen, and a mockup would be the one lie on the
        // shelf. The triggers figure IS the hero; a real screen (the fleet board) carries a block below.
        heroFigure: "triggers",
        facts: [
            { value: "6 events", label: "push, alert, payment, email, chat or cron" },
            { value: "1 guard", label: "a command you write vets every wake" },
            { value: "Fresh session", label: "each run its own transcript and worktree" },
        ],
        blocks: [
            {
                title: "A persona with permissions, not a free-for-all",
                body: "Each automation runs as an agent persona you've configured — which model, which tools, how much it may do unattended. The guard command runs first and can veto the wake before a single token is spent.",
                bullets: [
                    "Wake on a GitHub push, a Sentry alert, a Stripe payment, inbound email, a Discord message, or cron",
                    "The guard is your code: it decides, per event, whether this one is worth an agent",
                ],
            },
            {
                title: "Watch every run land on the board",
                body: "A woken agent appears on your fleet board like any other — its own card, its transcript, its diff, the same review before anything lands. The nightly dependency audit arrives that way, already waiting when you get in.",
                shot: {
                    name: "fleet-board",
                    alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane where a completed agent offers Land now. Every card shows model, branch, tokens, cost and diff stats.",
                    frame: "browser",
                    label: "acme-shop · /agents",
                },
            },
            {
                title: "One run can wake the next",
                body: "An automation can finish by starting another, so a chain of specialists hands work down the line — triage wakes the fixer, the fixer wakes the reviewer — each a fresh session with its own transcript.",
            },
        ],
        meta: {
            title: "Automate · intentic",
            description:
                "Wake an agent on a schedule or an event — a push, an alert, a payment, an email, a chat message or cron — under permissions you set and a guard command you write. Every run is a fresh session you can watch.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "supervise",
        navLabel: "Supervise",
        menuBlurb: "It proposes, you approve, and nothing lands unread",
        heading: "It proposes. You approve. Nothing lands until you've read the diff.",
        sub: "Every agent starts in plan mode: it reads, writes a plan, and waits. You approve, steer, or reject — and its finished work sits on its own branch until you have read every hunk. You keep it sharp by curating what it knows, not by nagging it.",
        hero: {
            name: "chat-plan",
            alt: "The docked chat: the agent's thinking block, a Read tool call, a four-step plan for adding Stripe checkout, and two buttons: approve, or keep planning.",
            frame: "bare",
        },
        facts: [
            { value: "Plan first", label: "every agent reads, proposes, then waits for you" },
            { value: "Permission dial", label: "how much it may do unattended, per turn" },
            { value: "Land or discard", label: "one button each; nothing lands by surprise" },
        ],
        blocks: [
            {
                title: "The plan is the contract",
                body: "Before it edits anything, the agent shows which files it will touch and what it will do to each. Approve it and the plan becomes a to-do list you watch.",
                bullets: [
                    "Thinking, tool calls and to-dos stream as they happen, never summarised after the fact",
                    "Steer mid-turn: a message lands in the running turn instead of queuing behind it",
                    "The same conversation on your phone — an agent that stops at 11pm is one tap from unblocked",
                ],
            },
            {
                title: "Permission is a dial, not a switch",
                body: "The same conversation can be strict on a migration and loose on a changelog — the composer's mode pill sets how much the agent may do unattended, per turn. An approved plan is the exception: you have read what it intends, so it runs the lot.",
            },
            {
                title: "Reviewed by file, not by wall of text",
                body: "Finished work is grouped by repo with per-file line counts, so a 400-line change reads as six decisions. Comments attach to a hunk, and unread files stay marked until you have looked at them.",
                shot: {
                    name: "workspace-changes",
                    alt: "The workspace Changes tab: five uncommitted files grouped by repo with their line counts, and the diff of one of them open beside the list.",
                    frame: "browser",
                    label: "acme-shop · /workspace",
                },
            },
            {
                title: "The review boundary is a real branch",
                body: "Landing replays the agent's delta onto your tree as ordinary git changes you can stage, amend or revert. Discarding removes the worktree and leaves your tree untouched. A land conflict comes back as an Attention card the agent can resolve.",
                figure: "worktrees",
            },
            {
                title: "Steer it by what it knows, not by nagging",
                body: "You can't make the model smarter; you can make it better equipped. Open the context it loads every turn — skills, runbooks, house style — and the systems it may reach, and the same prompt does a better job.",
                figure: "prompt-vs-environment",
            },
            {
                title: "One workspace, two operators",
                body: "The editor, file tree, search and terminal aren't a viewer bolted onto the chat — they are the same surfaces the agent works through, so what it edits is what you open. Nothing reconciles your view with the agent's, because there is only one.",
                figure: "shared-surfaces",
            },
        ],
        meta: {
            title: "Supervise · intentic",
            description:
                "Co-pilot your agents: every one starts in plan mode, permission is a per-turn dial, finished work is reviewed diff by diff before it lands, and you steer by curating the context it loads.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "delegate",
        navLabel: "Delegate",
        menuBlurb: "Give it a server of its own and hand off the job",
        heading: "Delegate the running. Keep the owning.",
        sub: "A sandbox is a Docker container on your own laptop, desktop or VPS. Put it on a server, hand it end-to-end operation — and because the platform sits off the command path, you give up none of the control.",
        hero: {
            name: "sandbox-overview",
            alt: "The sandbox hub: the acme-shop sandbox online with its installed version and URL, and an at-a-glance list of its agent account, secrets, capabilities, running services and access.",
            frame: "browser",
            label: "acme-shop · /sandbox",
        },
        facts: [
            { value: "No code", label: "the platform never stores your source, your prompts or your credentials" },
            { value: "MIT", label: "all of intentic is open source, platform included" },
            { value: "No ports", label: "nothing inbound is opened; the tunnel dials out" },
        ],
        blocks: [
            {
                title: "It runs on hardware you own",
                body: "The sandbox dials out over a private Cloudflare tunnel and your browser talks to that address. Put the machine on a VPS and it keeps working without you — the platform never relays a file, a keystroke or a credential.",
                figure: "ownership",
            },
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
                body: "Identity, the sandbox's URL, and the grants that let a teammate reach it. Not your code, not your keys, not your transcripts.",
                figure: "platform-boundary",
            },
            {
                title: "One sandbox, several people",
                body: "The owner installs the tools; invited teammates share that same sandbox, each signed in as themselves. Setup stays owner-gated.",
                bullets: [
                    "Invite by email; grants are enforced by the daemon, fail-closed.",
                    "Teammates chat, drive and review, and mirror the sandbox's ports.",
                    "Revoking or leaving takes effect the moment you press it.",
                ],
                figure: "sharing",
            },
        ],
        meta: {
            title: "Delegate · intentic",
            description:
                "Run the sandbox on a server you own and hand it end-to-end operation: an image overlay you approve, a private tunnel your browser dials, a spend ledger the platform never sees, and the platform off the command path.",
            datePublished: PUBLISHED,
        },
    },
];

export const productPage = (slug: string): ProductPage | undefined => productPages.find((page) => page.slug === slug);
