import type { ShotImage } from "./landing";

/* The feature pages: one page per VERB: what you do with the workspace, not what a surface is called.
 *
 * The shelf used to list surfaces (Fleet board, Chat & plan mode, Review & land, the editor…), and half of
 * those read as table stakes any agentic editor has, so the menu undersold the product. It now names five
 * outcomes: Run, Connect, Automate, Review, Host, and each page folds the relevant surfaces underneath it as
 * proof. See docs/marketing/landing-blueprint.md ("The feature pages") for the mapping.
 *
 * THE SLUG IS THE LABEL, LOWERCASED, AND THAT IS THE RULE. These pages used to be shelved under /product/
 * with latinate slugs (orchestrate, empower, supervise, delegate) while the menu above them said Features,
 * Run, Connect, Review, Host: a visitor clicked one word and the address bar answered with another. A URL is
 * read: in a search result, in a shared link, in the status bar before the click. Two vocabularies for one
 * page means one of them is wrong, and the menu's is the one written for a reader.
 *
 * Every `src` here is still a file the screenshot harness wrote from the demo build
 * (`_tools/e2e/shots/capture.mts`), so a claim on these pages is a screen you can open in the live demo.
 * Where a surface has no honest screenshot yet, the page carries a DIAGRAM instead: never a mockup of a
 * screen that doesn't exist. Automate is the one diagram-led page, and no longer because it has to be: its
 * screen exists and the menu previews it. The drawing stays because that page opens by explaining a machine,
 * and the machine is not what a list of five already-configured automations is a picture of.
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
    /** The one line of scent under the label in the mega-menu: kept to a few words. */
    menuBlurb: string;
    /** The mega-menu row's icon key, resolved by the site's `navIcons`. */
    icon: string;
    heading: string;
    sub: string;
    /**
     * The hero visual. A page leads with a real screenshot (`hero`) OR, where a drawing explains the thing
     * better than any one screen does, a diagram (`heroFigure`): exactly one is set. Automate is the only
     * diagram-led page, see the note on its own entry for why the drawing outranks the screen it now has.
     */
    hero?: ProductShot;
    heroFigure?: ProductFigure;
    /* THE PICTURE THE MEGA-MENU PREVIEWS, where the hero is the wrong picture for that box.
     *
     * The menu previews a row in a 16:10 frame 544px wide; a hero is framed for a page column, so it is a wide
     * strip of a surface or a tall column of one. Run and Connect survive the difference, their heroes are
     * near enough to the box that its crop still lands on lanes and tiles. Review and Host did not: one was a
     * chat shot 1:2 tall, previewing as a blown-up inch of its own header, and the other a 2.5:1 strip that
     * left a third of the frame empty.
     *
     * Automate had no picture at all, being diagram-led, and a row with no picture does not leave the rail
     * empty, it leaves the LAST row's picture in it, so Automate showed you the capabilities catalog. It gets
     * a capture of its own screen, which is also what keeps the rail coherent: five rows, five screenshots,
     * rather than four screenshots and a drawing floating in a box the others fill edge to edge.
     *
     * So those three name their own capture, shot to the frame (`_tools/e2e/shots/capture.mts`, "menu-*"). Same
     * demo, same rule as every other shot here: a real surface, not a mockup.
     *
     * Connect was given one too and had it taken away again, which is worth writing down: the narrow window
     * that makes these frames legible is also the width at which the capabilities catalog folds its category
     * list into a dropdown, so the tighter shot bought bigger tiles by losing the shelf of kinds that is the
     * actual point of that screen. Its hero, cropped, says more. */
    menuShot?: ShotImage;
    facts: ProductFact[];
    blocks: ProductBlock[];
    /* THE GUIDE THIS SURFACE ANSWERS. A feature page presupposes intentic: it says what this product's
     * Review screen does, to somebody who already knows there is one. The guide shelf answers the question
     * underneath it ("how do I check what an agent changed"), asked by somebody who does not. The two were
     * linked in one direction only, so a reader who arrived on the question could reach the product and a
     * reader who arrived on the product could never get back to the question. */
    guide: { slug: string; question: string };
    meta: { title: string; description: string; datePublished: string };
}

export const productHref = (slug: string): string => `/features/${slug}/`;

const PUBLISHED = "2026-08-09";

export const productPages: ProductPage[] = [
    {
        slug: "run",
        navLabel: "Run",
        menuBlurb: "Many agents, one board",
        icon: "play",
        heading: "Run many agents. See which one needs you.",
        sub: "A chat window works for one agent. The board shows the status, changes and cost of every agent at once.",
        hero: {
            name: "fleet-board",
            alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane where a completed agent offers Land now. Every card shows model, branch, tokens, cost and diff stats.",
            frame: "browser",
            label: "acme-shop · /agents",
        },
        facts: [
            { value: "3 lanes", label: "Attention, Active, Finished. The board sorts itself" },
            { value: "1 branch each", label: "every agent gets an isolated checkout" },
            { value: "6 agents", label: "Claude Code, Codex, Grok, Kimi Code, Google, Cursor" },
        ],
        blocks: [
            {
                title: "See what needs your attention first",
                body: "An agent that needs a decision stops and moves to the Attention lane. You get one short list of the agents waiting for you.",
                bullets: [
                    "Question for you · Approval needed · Merge conflict, each with the one action that clears it",
                    "Everything else keeps running while you answer",
                ],
            },
            {
                title: "See status and cost at a glance",
                body: "Each card shows the model, branch, turns, tokens, cost and current diff. You do not need to open the full transcript.",
                shot: {
                    name: "mobile-fleet",
                    alt: "The same fleet board on a phone: agent cards stacked in one column with model, branch, cost and diff stats.",
                    frame: "phone",
                },
            },
            {
                title: "Fan out across models and machines",
                body: "A turn can start full child agents on any connected provider, each as an isolated conversation you can watch and review. Connect runner containers on your other computers and the fleet spreads those children across ready capacity while their transcript and land door stay here.",
                bullets: [
                    "Cross-provider meta-harness: Claude can delegate to Cursor, Codex to Claude, or any other connected pair",
                    "Remote runners replicate the approved environment and return git branches, not a second control plane",
                ],
            },
            {
                title: "Isolated by construction",
                body: "Each agent works in its own git worktree, so they never collide and no change is merged without your approval.",
                figure: "worktrees",
            },
        ],
        guide: { slug: "run-multiple-coding-agents-in-parallel", question: "Can several AI coding agents work on the same repository at once?" },
        meta: {
            title: "Run a fleet · intentic",
            description:
                "Run ten coding agents at once and see which needs you: attention lanes, per-agent cost and diffs, one git worktree each, the whole fleet on one board.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "connect",
        navLabel: "Connect",
        menuBlurb: "Wire in outside systems",
        icon: "link",
        heading: "Connect agents to the systems they need.",
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
                    name: "front-desk",
                    alt: "A robotics company's website with the Front Desk widget open in the corner: the agent greets the visitor, the visitor asks whether the arms work outdoors, and the agent answers with the IP66 rating and a cold-weather caveat, then offers to open a ticket.",
                    frame: "browser",
                    label: "a customer's site",
                },
            },
        ],
        guide: { slug: "give-an-ai-agent-database-and-api-access-safely", question: "Should an AI coding agent ever hold your database password?" },
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
        menuBlurb: "Start on schedule or event",
        icon: "zap",
        heading: "Start an agent automatically.",
        sub: "Choose a schedule or event. Add an optional check command that decides whether each run should start.",
        /* Diagram-led BY CHOICE, not for want of a screen. This used to say there was no automations screen to
         * shoot; there is one (`/ext/automations`, and the menu previews it), so what keeps the drawing here is
         * that the page's first job is explaining a machine nobody has seen yet, six triggers, one optional
         * check, a fresh session, which a list of five configured automations shows the RESULT of rather than
         * the shape of. The triggers figure IS the hero; a real screen (the fleet board) carries a block below. */
        heroFigure: "triggers",
        menuShot: {
            name: "menu-automate",
            alt: "The automations screen: one wake held for approval, two code chores triggered by a daily schedule and by work landing, and three integrations fired from Discord, a webchat and a webhook, each with when it last ran and a switch.",
        },
        facts: [
            { value: "6 events", label: "push, alert, payment, email, chat or cron" },
            { value: "1 check", label: "an optional command approves or skips each run" },
            { value: "Fresh session", label: "each run gets its own transcript and isolated checkout" },
        ],
        blocks: [
            {
                title: "Control what starts and what it can do",
                body: "Each run uses the identity, model, permissions and limits you set. An optional check command can skip the run before it uses any tokens.",
                bullets: [
                    "Wake on a GitHub push, a Sentry alert, a Stripe payment, inbound email, a Discord message, or cron",
                    "The check is your own code. It decides whether a specific event needs an agent",
                ],
            },
            {
                title: "See every automated run on the board",
                body: "An automatically started agent appears like any other, with its own card, diff and review.",
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
        guide: {
            slug: "keep-a-coding-agent-running-after-you-close-your-laptop",
            question: "Will a coding agent keep working after you close your laptop?",
        },
        meta: {
            title: "Automate · intentic",
            description:
                "Start an agent from a push, alert, payment, email, chat or schedule. You set its permissions, and every run opens a session you can watch.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "review",
        navLabel: "Review",
        menuBlurb: "Approve every change first",
        icon: "circle-check",
        heading: "It proposes. You approve. Nothing is merged until you read the diff.",
        sub: "Every agent plans first, then waits. Review each file before you accept the change.",
        menuShot: {
            name: "menu-review",
            alt: "The workspace Changes tab: five uncommitted files across two repos with their added and removed line counts, nothing staged, and the largest of them open in a side-by-side diff.",
        },
        hero: {
            name: "chat-plan",
            alt: "The docked chat: the agent's thinking block, a Read tool call, a four-step plan for adding Stripe checkout, and two buttons: approve, or keep planning.",
            frame: "bare",
        },
        facts: [
            { value: "Plan first", label: "every agent reads, proposes, then waits for you" },
            { value: "Permission dial", label: "how much it may do unattended, per turn" },
            { value: "Accept or discard", label: "one button each; no change is accepted by surprise" },
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
                body: "Accepting the agent's work adds ordinary git changes you can stage, amend or revert.",
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
        guide: { slug: "review-ai-generated-code-changes", question: "Is an AI agent's summary of its own diff enough to merge on?" },
        meta: {
            title: "Review agent work · intentic",
            description:
                "Every agent starts in plan mode, permission is a per-turn dial, and finished work is reviewed diff by diff before anything lands in your tree.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "host",
        navLabel: "Host",
        menuBlurb: "Self-hosted",
        icon: "server",
        heading: "Host the work. Keep control.",
        sub: "A sandbox is a Docker container on your laptop, desktop or server. Move it to a server so agents can keep working when your laptop is off.",
        menuShot: {
            name: "menu-host",
            alt: "The sandbox hub: the acme-shop box online with its installed version and its own URL, over the list of what it holds, environment, secrets, agent account, extensions, access, personas and computers.",
        },
        hero: {
            name: "sandbox-overview",
            alt: "The sandbox hub: the acme-shop sandbox shown online with its installed version and its own URL, beside the list of everything it holds: environment, secrets, agent account, extensions, access, personas and computers.",
            frame: "browser",
            label: "acme-shop · /sandbox",
        },
        facts: [
            { value: "No code", label: "the platform stores no source, prompts or credentials" },
            { value: "MIT", label: "all of intentic is open source, platform included" },
            { value: "No open ports", label: "the sandbox makes a private outbound connection" },
        ],
        blocks: [
            {
                title: "Self-hosted",
                body: "A private tunnel connects your browser to the sandbox. On a server, it keeps running without you.",
                figure: "ownership",
            },
            {
                title: "You control what is installed",
                body: "A Dockerfile defines the sandbox's installed software. The agent can propose a change, but it waits for your approval before applying it.",
                shot: {
                    name: "sandbox-environment",
                    alt: "The sandbox Environment tab: an overlay Dockerfile diff awaiting review, adding an imagemagick install, with Reject and Approve buttons.",
                    frame: "browser",
                    label: "acme-shop · /sandbox/environment",
                },
            },
            {
                title: "Make the environment reproducible",
                body: "Download its live shape as sandbox.toml: repository remotes, connection shapes, secret names, the approved overlay and non-default agent settings. Commit it, compare another sandbox for drift, or seed a fleet without exporting a credential or transcript.",
                bullets: [
                    "Definitions are deterministic TOML derived from the live sandbox, never a stale second copy",
                    "Applying one is preview-first: overlays wait for the new owner's approval and connections wait for authentication",
                ],
            },
            {
                title: "See usage where it happens",
                body: "The sandbox records the tokens and cost of each turn. The usage stays in your own ledger because the AI account is yours.",
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
                    "Invite people by email. The sandbox enforces their access, not just the interface.",
                    "Teammates can chat, work, review and open the web apps running in the sandbox.",
                    "Removing someone's access takes effect immediately.",
                ],
                figure: "sharing",
            },
        ],
        guide: { slug: "where-your-code-goes-with-cloud-coding-agents", question: "Where does your code go when you use a cloud coding agent?" },
        meta: {
            title: "Host agent work · intentic",
            description:
                "Run the sandbox on a server you own. You approve installed software, connect through a private tunnel and keep usage data in the sandbox.",
            datePublished: PUBLISHED,
        },
    },
];

export const productPage = (slug: string): ProductPage | undefined => productPages.find((page) => page.slug === slug);
