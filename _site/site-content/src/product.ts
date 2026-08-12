import type { ShotImage } from "./landing";

/* The feature pages: one page per VERB: what you do with the workspace, not what a surface is called.
 *
 * The shelf used to list surfaces (Fleet board, Chat & plan mode, Review & land, the editor…), and half of
 * those read as table stakes any agentic editor has, so the menu undersold the product. It now names five
 * outcomes: Orchestrate, Empower, Automate, Supervise, Delegate, and each page folds the relevant surfaces
 * underneath it as proof. See docs/marketing/landing-blueprint.md ("The feature pages") for the mapping.
 *
 * Every `src` here is still a file the screenshot harness wrote from the demo build
 * (`_tools/e2e/shots/capture.mts`), so a claim on these pages is a screen you can open in the live demo.
 * Where a surface has no honest screenshot yet, the page carries a DIAGRAM instead: never a mockup of a
 * screen that doesn't exist. Automate has no captured screen at all, so it is diagram-led: its hero is the
 * triggers figure, not an invented UI.
 */

/** How a shot is framed on the page: a browser window, a phone, or the bare image. */
export type ShotFrame = "browser" | "phone" | "bare";

export interface ProductShot extends ShotImage {
    frame: ShotFrame;
    /** The pill in the browser frame's title bar. Where in the app this was taken. */
    label?: string;
}

/** A figure drawn in markup rather than screenshotted: the parts of the story that have no single screen. */
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

/** One verifiable number or fact under the hero: never an estimate, never a benchmark we didn't run. */
export interface ProductFact {
    value: string;
    label: string;
}

export interface ProductPage {
    slug: string;
    /** Menu label and page eyebrow: the verb. */
    navLabel: string;
    /** The one line of scent under the label in the mega-menu. */
    menuBlurb: string;
    heading: string;
    sub: string;
    /**
     * The hero visual. A page leads with a real screenshot (`hero`) OR, where the surface has no honest
     * screenshot, a diagram (`heroFigure`): exactly one is set. Automate is the only diagram-led page:
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
        navLabel: "Run",
        menuBlurb: "Run ten agents at once and see which one needs you",
        heading: "Run the fleet. Get pulled in only when one needs you.",
        sub: "One agent is a chat window. Ten need a board: who is running, who is blocked, what each one spent.",
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
                body: "An agent that needs a decision stops and says so on its card. Ten agents read as a short list of things only you can do.",
                bullets: [
                    "Question for you · Approval needed · Land conflict, each with the one action that clears it",
                    "Everything else keeps running while you answer",
                ],
            },
            {
                title: "Every card carries the receipts",
                body: "See the model, branch, turns, tokens, cost and current diff without opening a transcript.",
                shot: {
                    name: "mobile-fleet",
                    alt: "The same fleet board on a phone: agent cards stacked in one column with model, branch, cost and diff stats.",
                    frame: "phone",
                },
            },
            {
                title: "Isolated by construction",
                body: "Each agent works in its own git worktree, so they never collide and nothing lands unapproved.",
                figure: "worktrees",
            },
        ],
        meta: {
            title: "Run a fleet · intentic",
            description:
                "Run ten coding agents at once and see which needs you: attention lanes, per-agent cost and diffs, one git worktree each, the whole fleet on one board.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "empower",
        navLabel: "Connect",
        menuBlurb: "Connect agents to the systems they need",
        heading: "An agent is only as useful as what it can reach.",
        sub: "Connect GitHub, Postgres, Stripe, Discord or any MCP server. Every key stays in your sandbox.",
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
                title: "See what a connection adds before you save it",
                body: "Before you paste a token, the card shows what it adds: a skill, a secret, a tool.",
                shot: {
                    name: "capability-github",
                    alt: "The GitHub capability: a connected instance, a name field, a personal access token field, a Git access toggle, and a panel listing what it adds to the sandbox: a skill the agent loads next turn and a secret injected into its environment.",
                    frame: "browser",
                    label: "acme-shop · /capabilities/github",
                },
            },
            {
                title: "The credential never leaves the sandbox",
                body: "Secrets live in your sandbox and are injected each turn. The platform has no path to them.",
                figure: "platform-boundary",
            },
            {
                title: "The systems around one sandbox",
                body: "A specialized agent is a few capabilities from a real job: repo, database, error tracker, chat.",
                figure: "integrations",
            },
            {
                title: "Talk to it where your team already works",
                body: "Connect Discord or Slack, then @mention the agent and get its reply in the same place.",
                figure: "teammate",
            },
            {
                title: "Put it on your own website",
                body: "One script tag adds a chat bubble answered by your agent. Every chat opens on your board.",
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
            title: "Connect agents · intentic",
            description:
                "Connect an agent to GitHub, PostgreSQL, Sentry, Stripe, Discord, SSH or any MCP server. Each installs a real tool, and its key never leaves your sandbox.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "automate",
        navLabel: "Automate",
        menuBlurb: "Agents that start themselves on an event, and act",
        heading: "Agents that start on a schedule or event.",
        sub: "A push, alert, payment, email, chat or cron wakes an agent. A guard you write vets every run.",
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
                body: "Each wake uses the persona, model and limits you set, and the guard can stop it before a token is spent.",
                bullets: [
                    "Wake on a GitHub push, a Sentry alert, a Stripe payment, inbound email, a Discord message, or cron",
                    "The guard is your code: it decides, per event, whether this one is worth an agent",
                ],
            },
            {
                title: "Watch every run land on the board",
                body: "A woken agent lands on your board like any other: its own card, diff and review.",
                shot: {
                    name: "fleet-board",
                    alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane where a completed agent offers Land now. Every card shows model, branch, tokens, cost and diff stats.",
                    frame: "browser",
                    label: "acme-shop · /agents",
                },
            },
            {
                title: "One run can wake the next",
                body: "Work hands down a chain: triage wakes the fixer, the fixer wakes the reviewer.",
            },
        ],
        meta: {
            title: "Automate · intentic",
            description:
                "Wake an agent from a push, alert, payment, email, chat or cron. You set its permissions and guard command, and every run opens a session you can watch.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "supervise",
        navLabel: "Review",
        menuBlurb: "It proposes, you approve, and nothing lands unread",
        heading: "It proposes. You approve. Nothing lands until you've read the diff.",
        sub: "Every agent plans first, then waits. Nothing lands until you have read every hunk.",
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
                body: "Before editing, it shows which files it will touch. Approve, and the plan becomes a to-do list you watch.",
                bullets: [
                    "Thinking, tool calls and to-dos stream as they happen, never summarised after the fact",
                    "Steer mid-turn: a message lands in the running turn instead of queuing behind it",
                    "Continue the same conversation on your phone and unblock an agent with one tap",
                ],
            },
            {
                title: "Permission is a dial, not a switch",
                body: "A pill sets how far the agent may go each turn: strict for a migration, loose for a changelog.",
            },
            {
                title: "Reviewed by file, not by wall of text",
                body: "Work is grouped by file, so a 400-line change reads as six decisions. Unread files stay marked until you look.",
                shot: {
                    name: "workspace-changes",
                    alt: "The workspace Changes tab: five uncommitted files grouped by repo with their line counts, and the diff of one of them open beside the list.",
                    frame: "browser",
                    label: "acme-shop · /workspace",
                },
            },
            {
                title: "The review boundary is a real branch",
                body: "Landing adds the agent's work as ordinary git changes you can stage, amend or revert.",
                figure: "worktrees",
            },
            {
                title: "Steer it by what it knows, not by nagging",
                body: "You can't make the model smarter, but you can equip it: better context and tools each turn.",
                figure: "prompt-vs-environment",
            },
            {
                title: "One workspace, two operators",
                body: "You and the agent share one workspace. You open the same editor, files and terminal it uses.",
                figure: "shared-surfaces",
            },
        ],
        meta: {
            title: "Review agent work · intentic",
            description:
                "Every agent starts in plan mode, permission is a per-turn dial, and finished work is reviewed diff by diff before anything lands in your tree.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "delegate",
        navLabel: "Host",
        menuBlurb: "Give it a server of its own and hand off the job",
        heading: "Host the work. Keep control.",
        sub: "A sandbox is a Docker container on your laptop, desktop or server. Hand off the running, keep the control.",
        hero: {
            name: "sandbox-overview",
            alt: "The sandbox hub: the acme-shop sandbox shown online with its installed version and its own URL, beside the list of everything it holds: environment, secrets, agent account, extensions, access, personas and computers.",
            frame: "browser",
            label: "acme-shop · /sandbox",
        },
        facts: [
            { value: "No code", label: "the platform stores no source, prompts or credentials" },
            { value: "MIT", label: "all of intentic is open source, platform included" },
            { value: "No ports", label: "nothing inbound is opened; the tunnel dials out" },
        ],
        blocks: [
            {
                title: "It runs on hardware you own",
                body: "A private tunnel connects your browser to the sandbox. On a server, it keeps running without you.",
                figure: "ownership",
            },
            {
                title: "The image is a file you approve",
                body: "The image is a Dockerfile you own. The agent proposes a change and waits for your approval.",
                shot: {
                    name: "sandbox-environment",
                    alt: "The sandbox Environment tab: an overlay Dockerfile diff awaiting review, adding an imagemagick install, with Reject and Approve buttons.",
                    frame: "browser",
                    label: "acme-shop · /sandbox/environment",
                },
            },
            {
                title: "The bill is measured where it is spent",
                body: "Each turn's tokens and cost land in the sandbox's own ledger. It is your plan, so nobody meters it.",
                shot: {
                    name: "sandbox-spend",
                    alt: "The sandbox Usage tab: a stacked spend-per-day chart split by Claude Code and Codex, with cost broken down by model and by agent.",
                    frame: "browser",
                    label: "acme-shop · /sandbox/usage",
                },
            },
            {
                title: "What the platform actually holds",
                body: "It stores your identity, sandbox URL and teammate access. It does not store your code, keys or transcripts.",
                figure: "platform-boundary",
            },
            {
                title: "One sandbox, several people",
                body: "The owner installs the tools; invited teammates share the sandbox, each signed in as themselves.",
                bullets: [
                    "Invite by email; grants are enforced by the daemon, fail-closed.",
                    "Teammates chat, drive and review, and mirror the sandbox's ports.",
                    "Revoking or leaving takes effect the moment you press it.",
                ],
                figure: "sharing",
            },
        ],
        meta: {
            title: "Host agent work · intentic",
            description:
                "Run the sandbox on a server you own: an image you approve, a tunnel your browser dials, a spend ledger nobody else sees, and no platform on the path.",
            datePublished: PUBLISHED,
        },
    },
];

export const productPage = (slug: string): ProductPage | undefined => productPages.find((page) => page.slug === slug);
