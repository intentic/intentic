/* The comparison shelf: "how does intentic compare to X?", answered honestly and once per X.
 *
 * The question arrives constantly and the naive answer — a feature matrix where every row is a tick for us —
 * is the fastest way to lose the credibility the rest of the site is built on. So the shelf is organised
 * around a fact that is true and disarming: MOST of the tools people name are not competitors. Five of them
 * are agent harnesses this product runs (`_platform/capability-catalog/src/index.ts`, the ACP cards), the editors
 * keep working through desktop sync and `@intentic/acp-bridge`, and only the cloud agent platforms are a real
 * either/or. Saying that plainly is both truer and more persuasive than a scorecard.
 *
 * Every page therefore carries a `pickThem` — the case for the other product, written to be usable — and
 * every table carries rows marked `theirs`. A table with no losing rows is a table nobody believes.
 *
 * Accuracy rules, because these describe other people's products:
 * - Quote their own words for what they are (`theirPitch`), and link `url` so a reader can check.
 * - No prices. Ours are a recorded no (docs/marketing/landing-blueprint.md); theirs rot within a quarter.
 * - Nothing about a competitor that isn't on their own public site today.
 */

export const compareHref = (slug: string): string => (slug ? `/compare/${slug}/` : `/compare/`);

const PUBLISHED = "2026-08-01";

/** One kind of tool people confuse this product with — the unit the hub is organised in. */
export interface CompareFamily {
    id: string;
    label: string;
    /** The verdict for the whole bucket, in three or four words. It is the thing to remember. */
    verdict: string;
    body: string;
    /** Named so the hub answers for tools that will never have a page of their own. */
    examples: string[];
}

/** One line of the head-to-head table. */
export interface CompareRow {
    /** The dimension, phrased as the thing a reader is actually deciding about. */
    label: string;
    intentic: string;
    them: string;
    /** Set where the row goes the other way. These rows are why the table is worth reading. */
    theirs?: boolean;
}

export interface CompareSection {
    title: string;
    body: string;
}

export interface ComparePage {
    slug: string;
    /** The other product, spelled the way it spells itself. */
    name: string;
    /** Their site — every claim on the page has to be checkable there. */
    url: string;
    /** Nav and footer row. */
    navLabel: string;
    menuBlurb: string;
    family: string;
    heading: string;
    sub: string;
    /** What they are, close to their own words. Quoted where it is a direct lift. */
    theirPitch: string;
    /** The answer, before any table. If a reader stops here they should still have it. */
    verdict: string[];
    /** Where the two genuinely overlap. Written generously — it earns the right to the next section. */
    overlap: CompareSection;
    differences: CompareSection[];
    table: CompareRow[];
    /** Present where the honest answer is "run both", with the mechanism that makes it true. */
    together?: CompareSection;
    /** The case for them. A real recommendation, not a strawman. */
    pickThem: string;
    meta: { title: string; description: string; datePublished: string };
}

export const compareFamilies: CompareFamily[] = [
    {
        id: "harnesses",
        label: "Agent CLIs",
        verdict: "intentic runs these",
        body: "A harness turns a model into an agent in your terminal: the loop, the tools, the permission prompts. It is the engine, not the garage. intentic is what one runs inside, with five built in and any ACP agent a capability away.",
        examples: ["Claude Code", "Codex", "Grok", "Kimi Code", "Gemini CLI", "OpenCode", "Goose", "Qwen Code"],
    },
    {
        id: "editors",
        label: "AI editors",
        verdict: "keep yours",
        body: "An AI editor puts you at the keyboard with a model helping. intentic puts the agent at the keyboard and you in review. Same files, different jobs: desktop sync mirrors the sandbox onto your machine, so your editor opens what an agent just wrote.",
        examples: ["Cursor", "Windsurf", "VS Code + Copilot", "Zed", "JetBrains AI"],
    },
    {
        id: "orchestrators",
        label: "Local agent orchestrators",
        verdict: "same instinct, wider scope",
        body: "The closest neighbours, and the ones that got ownership right: several agents at once, each on its own worktree, on your hardware — and several now answer from a phone too. Where intentic keeps going is the layer under the agent: the image it runs in, the credentials it operates, the events that wake it, the teammates who share it.",
        examples: ["Conductor", "Superset", "T3 Code", "Synara", "Nimbalyst", "Crystal", "Vibe Kanban", "Sculptor"],
    },
    {
        id: "cloud",
        label: "Cloud agent platforms",
        verdict: "the opposite trade",
        body: "The only genuine either/or on this page. They run the agent on their infrastructure, so your source and your keys sit in their sandbox. intentic gives the same remote experience with the sandbox on hardware you own.",
        examples: ["Devin", "Cursor cloud agents", "Codex cloud", "Claude Code on the web", "Jules", "Replit Agent"],
    },
];

export const comparePages: ComparePage[] = [
    {
        slug: "conductor",
        name: "Conductor",
        url: "https://www.conductor.build/",
        navLabel: "vs Conductor",
        menuBlurb: "Parallel agents on a Mac, versus a sandbox you configure",
        family: "orchestrators",
        heading: "Both run a fleet. Only one of them builds the fleet a workplace.",
        sub: "Conductor and intentic answer the same first question: how do you run five agents at once without them writing over each other. Then they diverge on what an agent needs around it.",
        theirPitch: "“Run parallel Claude Code, Codex, and Cursor agents in isolated workspaces on your Mac.”",
        verdict: [
            "Conductor is a native Mac app that orchestrates agents on the machine you are sitting at. If that is the whole job, it may be all you need.",
            "intentic gives your agents a sandbox of their own: a container whose image you approve, each agent on its own git worktree inside it, credentials for your systems, events that wake them, and a browser that reaches them from anywhere.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Agents run in parallel, each in its own git worktree, on your hardware and your own subscription. Nothing merges until you have read the diff.",
        },
        differences: [
            {
                title: "A sandbox, not your laptop as it already is",
                body: "Conductor runs agents in your existing local environment, so what an agent can do is whatever you happen to have installed. In intentic they work in a sandbox whose image is an overlay Dockerfile — the agents propose what they need installed, and you read it and approve before anything is built.",
            },
            {
                title: "Credentials the agent operates, not credentials in your shell",
                body: "Capabilities wire a sandbox to GitHub, PostgreSQL, Sentry, Discord, Slack, SSH or any MCP server. The secret is written inside the sandbox and injected each turn, with no path from the platform to it.",
            },
            {
                title: "The machine and the screen come apart",
                body: "The sandbox is Docker, so it runs on a workstation, a VPS, a Mac or a Windows PC and dials out over a private tunnel. The machine doing the work need not be the machine you are looking at.",
            },
            {
                title: "Agents that run when you are not there",
                body: "Automations wake an agent on a schedule, a push, an alert, a payment, an email or a chat message — and on the fleet's own events, when a turn settles or a landed change breaks the build. A guard command can decide the wake is not worth it before a single token is spent.",
            },
            {
                title: "Two different answers to “what about remote?”",
                body: "Conductor's is Pro's cloud workspaces, and their own privacy note is straight about the consequence: they must store your session inputs and outputs. intentic's answer is that your machine was already remote.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your Mac, or their cloud workspace on Pro" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS" },
            { label: "How you reach it", intentic: "any browser over a private tunnel, phone included", them: "the Mac it is running on" },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your local machine, as it already is",
            },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "your local shell" },
            {
                label: "Runs without you at the keyboard",
                intentic: "automations on cron, webhook, push, alert, email, chat",
                them: "you start each session",
            },
            { label: "Isolation", intentic: "one git worktree per agent", them: "one git worktree per agent" },
            {
                label: "Native desktop app",
                intentic: "a native app on Windows and Linux, browser everywhere else, plus two-way desktop sync",
                them: "a real macOS app",
                theirs: true,
            },
            {
                label: "A machine you do not have to provide",
                intentic: "you bring the hardware",
                them: "cloud workspaces, nothing to host",
                theirs: true,
            },
            { label: "Source you can read", intentic: "all of it — MIT on GitHub, platform included", them: "closed source" },
        ],
        pickThem:
            "You work on one Mac and want a native app rather than a browser, your agents only ever need the toolchain already on that Mac, and you would rather rent a cloud workspace than provide a machine.",
        meta: {
            title: "intentic vs Conductor · parallel agents, compared",
            description:
                "Both run parallel coding agents on your own hardware, each in its own git worktree. Where they differ: the sandbox image, capabilities, automations, and reach from any browser.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "cursor",
        name: "Cursor",
        url: "https://cursor.com/",
        navLabel: "vs Cursor",
        menuBlurb: "You at the keyboard, or your agents at the keyboard",
        family: "editors",
        heading: "Cursor is where you write code. intentic is where your agents do.",
        sub: "This is the comparison that most often ends in “both”. Different jobs on the same files, with a mechanism that makes running both real.",
        theirPitch:
            "“Your coding agent for building ambitious software”: an AI editor, with desktop agents, cloud agents, a CLI and automations around it.",
        verdict: [
            "Cursor's centre of gravity is the cursor in a file: completion, inline edits, a model that knows what you are looking at. Everything it has added since is arranged around that.",
            "intentic's centre of gravity is a board of agents sorted by which one needs a decision from you. The editor exists so you can read and steer what they wrote, not so you can out-type them.",
            "If you want the model to help you write, use Cursor. If you want to run five agents and review their diffs, that is this. Keeping both is the normal outcome, not a compromise.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Both run agents in parallel, both make you read a diff before anything is yours, and both have automations. Cursor's inline editing has no equivalent here and is not trying to get one.",
        },
        differences: [
            {
                title: "Whose computer the background agent uses",
                body: "Cursor's cloud agents run on Cursor's machines, which is what makes them zero-setup. intentic's run in a container on yours, reached over a tunnel it dials out. Same remote experience, opposite custody.",
            },
            {
                title: "The environment is a file you approve",
                body: "In an editor the agent inherits your machine. Here it has an image of its own, extended by an overlay Dockerfile you approve, plus capabilities that wire it to your systems.",
            },
            {
                title: "Whose bill the tokens land on",
                body: "intentic runs on the Claude, ChatGPT, SuperGrok or Kimi Code subscription you already pay for — or a plain Google sign-in, free — and never meters or marks up model usage. The ledger lives in your sandbox.",
            },
            {
                title: "Supervision as a surface, not a notification",
                body: "Ten agents need somewhere to be ranked. An agent that needs a decision stops and says so, and the board sorts its card into Attention with the reason on it — so a fleet reads as a short list of things only you can do.",
            },
        ],
        table: [
            { label: "Who is at the keyboard", intentic: "the agent; you configure and review", them: "you; the model assists" },
            { label: "Inline completion and Cmd+K editing", intentic: "not offered", them: "the core of the product", theirs: true },
            { label: "Where a background agent runs", intentic: "your hardware, in a sandbox", them: "Cursor's cloud" },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "rules, MCP servers, your local machine",
            },
            { label: "Model billing", intentic: "your own account, no metering by us", them: "Cursor's plans, or your API keys" },
            {
                label: "Supervising many agents",
                intentic: "a fleet board with an Attention lane",
                them: "an agents list in the editor and on the web",
            },
            {
                label: "Editor maturity",
                intentic: "tree, editor, search, terminal and diffs — but no IntelliSense",
                them: "a full IDE, forked from VS Code",
                theirs: true,
            },
            { label: "Source you can read", intentic: "all of it is MIT on GitHub", them: "closed source" },
        ],
        together: {
            title: "Run both, and mean it",
            body: "Turn on desktop sync and the sandbox mirrors into a folder on your own machine, both ways. Open it in Cursor and you edit the same tree your agents work in: they land a diff, your editor sees it.",
        },
        pickThem:
            "The work is you typing: refactoring by hand with the model completing around you, or living inside one repo all day. Cursor is very good at that.",
        meta: {
            title: "intentic vs Cursor · the editor and the agent workspace",
            description:
                "Cursor puts you at the keyboard with a model helping; intentic puts your agents at the keyboard with you reviewing. How they differ, and how desktop sync makes running both real.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "claude-code",
        name: "Claude Code",
        url: "https://www.claude.com/product/claude-code",
        navLabel: "vs Claude Code",
        menuBlurb: "The terminal agent, and the workspace it runs in",
        family: "harnesses",
        heading: "Claude Code is the agent. intentic is where you keep it.",
        sub: "Claude Code, Codex, Grok, Kimi Code and Google are harnesses: the loop, the tools, the permission prompts. This is not a choice between them and intentic, because intentic runs them.",
        theirPitch: "Anthropic's coding agent for your terminal, and the same shape as Codex, Grok, Kimi Code and Gemini CLI.",
        verdict: [
            "Pick a harness the way you pick a compiler. Where it runs, what it can reach and who is watching it are still entirely open, and that is what intentic answers.",
            "Every conversation picks its agent from the same five, switchable per turn. The terminal is still there, sharing one tmux server with the agent's shell.",
        ],
        overlap: {
            title: "Where we agree",
            body: "It is the same agent, on the same subscription, on the same files. Nothing is proxied and no tokens are marked up. You get Claude Code doing what Claude Code does, with a board and a diff reader around it.",
        },
        differences: [
            {
                title: "One terminal, or a board of them",
                body: "A CLI is single-player by construction: one conversation per window, one working tree. The fleet board gives each agent its own worktree and ranks them by which needs a decision.",
            },
            {
                title: "Available from a browser, including a phone",
                body: "The sandbox dials out over a private tunnel and your browser talks to it. The same conversation is one tap away on a phone, which is the difference between an agent blocked overnight and one unblocked.",
            },
            {
                title: "An environment you can change",
                body: "A CLI inherits the machine it was launched on. Here the machine is an image: an overlay Dockerfile you approve, plus capabilities that install a real client and keep its credential inside.",
            },
            {
                title: "Asleep when you are, or woken by events",
                body: "Automations wake a session on a schedule, a push, an alert, a payment, an email or a chat message, each with its own transcript and an optional guard command. A CLI runs when you run it.",
            },
            {
                title: "One index, one tmux, one tree",
                body: "Your search box and the agent's Bash calls hit the same iq index. Your terminal and its shell share one tmux server. What it edits is what you open.",
            },
        ],
        table: [
            { label: "The agent itself", intentic: "Claude Code, Codex, Grok, Kimi Code or Google, per turn", them: "Claude Code" },
            { label: "Whose subscription pays", intentic: "yours, connected once, never metered by us", them: "yours" },
            {
                label: "Conversations at once",
                intentic: "ten at once, each on its own worktree",
                them: "one per terminal window, one working tree",
            },
            {
                label: "Where you drive it from",
                intentic: "any browser, phone included, over a private tunnel",
                them: "the terminal on that machine",
            },
            {
                label: "Reviewing changes",
                intentic: "a split or unified diff reader that diffs the code alone, then land or discard",
                them: "git, in your own terminal",
            },
            { label: "Cost visibility", intentic: "a ledger by day, provider, account, model and agent", them: "per-session totals" },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "you start it" },
            { label: "Setup", intentic: "Docker, a Google account, one pasted command", them: "one npm install, nothing else", theirs: true },
            {
                label: "Works with no account at all",
                intentic: "no — the workspace signs in with Google, self-hosted or not",
                them: "yes, just your Anthropic login",
                theirs: true,
            },
        ],
        together: {
            title: "You are already running it",
            body: "Claude Code is the default harness inside every intentic sandbox, and intentic is MIT throughout — platform included. You can read exactly what wraps your agent before you trust it.",
        },
        pickThem:
            "You live in one terminal on one machine and need none of the fleet, the browser or the automations. The bare CLI is excellent and this does not pretend otherwise.",
        meta: {
            title: "intentic vs Claude Code · the CLI and the workspace around it",
            description:
                "Claude Code is a harness; intentic is what it runs inside. A fleet board, a browser you reach from a phone, an editable sandbox image, and automations, on the same subscription.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "opencode",
        name: "OpenCode",
        url: "https://opencode.ai/",
        navLabel: "vs OpenCode",
        menuBlurb: "Add it as a provider; it is a capability here",
        family: "harnesses",
        heading: "You do not have to choose. OpenCode is a capability here.",
        sub: "OpenCode is an open-source agent that speaks the Agent Client Protocol, so it becomes one more provider in the chat picker: its own models, its own tools, its own config.",
        theirPitch:
            "“The open source AI coding agent”: a terminal, desktop and IDE agent with LSP integration, parallel sessions and 75+ model providers.",
        verdict: [
            "OpenCode is a harness, in the same category as Claude Code and Codex: it holds the agent loop and talks to whichever model you point it at. intentic is the environment a harness runs in.",
            "So the honest answer is not a comparison. Install the OpenCode capability and “opencode acp” becomes a provider row alongside Claude Code and Codex, inside the sandbox.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Both are open source and mean it: OpenCode's agent, and the whole of intentic — sandbox, platform and CLI — MIT on GitHub. Both run on your own accounts, and neither sits between you and your model provider.",
        },
        differences: [
            {
                title: "A harness, not a workplace",
                body: "OpenCode gives you the agent: the loop, the LSP integration, the model routing. It does not give the agent a machine of its own, credentials, or an event that wakes it.",
            },
            {
                title: "What ACP buys you here",
                body: "Any ACP agent becomes a chat provider in a sandbox: OpenCode and Gemini CLI have preset cards, and the custom card takes any command from the registry. Tool calls and inline diffs stream into the same chat surface.",
            },
            {
                title: "Model freedom, from two directions",
                body: "OpenCode's answer to lock-in is 75+ providers behind one agent. intentic's is five native harnesses plus every ACP agent as a capability. Installed together you get both.",
            },
        ],
        table: [
            { label: "What it is", intentic: "the environment an agent works in", them: "the agent itself" },
            { label: "Can run the other", intentic: "runs OpenCode as an ACP provider", them: "not applicable" },
            {
                label: "Model providers",
                intentic: "5 native harnesses, plus any ACP agent as a capability",
                them: "75+ providers behind one agent",
                theirs: true,
            },
            { label: "Where it runs", intentic: "a Docker sandbox on your hardware", them: "your machine: terminal, desktop or IDE" },
            { label: "Interface", intentic: "a browser workspace over a private tunnel", them: "TUI, desktop app, IDE extension" },
            {
                label: "Reviewing changes",
                intentic: "a diff reader over an isolated worktree, then land or discard",
                them: "git, and your editor's diff",
            },
            {
                label: "Credentials for your systems",
                intentic: "capabilities, stored sandbox-side, injected per turn",
                them: "your shell environment",
            },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "you start it" },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "open source throughout" },
        ],
        together: {
            title: "How to add it",
            body: "Capabilities → Extend → OpenCode. The card pre-fills the command, you sign in once from a Terminal or paste the keys its providers need, and it appears in the picker next turn. Same binary, running in the sandbox instead of your shell.",
        },
        pickThem:
            "You want one open-source agent you can read end to end, pointed at any of seventy-five providers, and you need no sandbox, capabilities, fleet or browser around it.",
        meta: {
            title: "intentic vs OpenCode · or rather, OpenCode inside intentic",
            description:
                "OpenCode is a harness; intentic is the environment one runs in. Install the OpenCode ACP capability and it becomes a provider in the chat picker, inside your sandbox.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "nimbalyst",
        name: "Nimbalyst",
        url: "https://nimbalyst.com/",
        navLabel: "vs Nimbalyst",
        menuBlurb: "Visual artefacts around the agent, or the machine under it",
        family: "orchestrators",
        heading: "Two open-source answers to the same question, built outward in different directions.",
        sub: "Nimbalyst and intentic share more than either shares with anything else here: local, open source, free to run, parallel sessions on git worktrees, a phone in your pocket.",
        theirPitch: "“Open-source visual workspace for coding agents. Build with Claude Code and Codex. Manage all the work around them.”",
        verdict: [
            "Nimbalyst builds outward toward the artefacts you and the agent share: markdown, mockups, Mermaid, Excalidraw, CSV, data models, each with a visual editor.",
            "intentic builds outward toward the machine underneath: the image, the credentials, the events that wake it, the tunnel that makes it reachable.",
            "Neither is the other's lesser version. If your work is as much documents and diagrams as it is code, their direction is the useful one.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Agents run locally on hardware you own, on a subscription you already have, in parallel with git worktree isolation. Both are open source — ours MIT across the whole product, platform included — both extensible, both answerable from a phone.",
        },
        differences: [
            {
                title: "The environment layer",
                body: "Nimbalyst runs agents against your local checkout with your local tools. In intentic the project gets a container of its own — an overlay Dockerfile you read and approve — so the agent that needs psql and a headless browser has them and your laptop does not.",
            },
            {
                title: "Systems, not just files",
                body: "Capabilities wire a sandbox to GitHub and GitLab, PostgreSQL and MySQL, Sentry, Stripe, Discord and Slack, IMAP mail, SSH, VPN, your own Windows or Linux computer and any MCP server — each with its credential kept inside. That is what lets an agent close the loop rather than hand you a patch.",
            },
            {
                title: "The machine does not have to be the screen",
                body: "Nimbalyst is a desktop app on the machine holding the code. intentic's sandbox dials out over a tunnel any browser reaches, so the work can happen on a VPS you never sit at.",
            },
            {
                title: "Running when nobody is watching",
                body: "Automations wake an agent on a schedule, on a webhook — a push, an alert, a payment — on new mail, on a CI result or on a workspace event, with an optional guard command you write deciding whether each wake runs. Invite the agent into Discord or Slack and it reads the channel, replies and reacts; in Discord it can sit in voice and transcribe.",
            },
            {
                title: "More than one person",
                body: "Invite a teammate by email and they reach the same sandbox signed in as themselves, with grants enforced fail-closed. Sharing is a Pro feature; revoking or leaving never is.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your machine, in your checkout" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS, Windows, Linux" },
            { label: "How you reach it", intentic: "any browser over a private tunnel", them: "a native desktop app, plus an iOS app", theirs: true },
            {
                label: "Visual editors for docs, mockups and diagrams",
                intentic: "a code editor and a diff reader",
                them: "markdown, mockups, Mermaid, Excalidraw, CSV, data models",
                theirs: true,
            },
            {
                label: "Task and plan tracking",
                intentic: "a fleet kanban, saved multi-step workflows, task lists that survive a rebuild",
                them: "tasks and a session kanban as first-class objects",
                theirs: true,
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your local machine, as it already is",
            },
            {
                label: "Credentials for your systems",
                intentic: "capabilities, stored sandbox-side, injected per turn",
                them: "your shell environment",
            },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "you start it" },
            { label: "Sharing with a teammate", intentic: "invite by email; grants enforced by the daemon", them: "one person, one machine" },
            { label: "Account required", intentic: "a Google sign-in for the hosted workspace", them: "none at all", theirs: true },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "MIT desktop and iOS apps" },
        ],
        pickThem:
            "Your work is as much documents, mockups and diagrams as it is code, you want to review an agent's changes visually rather than as a unified diff, and you would rather install one desktop app with no account than run a sandbox.",
        meta: {
            title: "intentic vs Nimbalyst · two open-source agent workspaces",
            description:
                "Both are local, open source and free to run, with parallel sessions on git worktrees. Nimbalyst builds out the visual artefacts; intentic builds out the machine under the agent.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "superset",
        name: "Superset",
        url: "https://superset.sh/",
        navLabel: "vs Superset",
        menuBlurb: "Nearly the same surfaces, minus the machine underneath",
        family: "orchestrators",
        heading: "The closest feature list on this page. The difference sits a layer below all of it.",
        sub: "Superset has almost every surface here: parallel worktrees, a diff viewer, terminals, an in-app browser, automations, a CLI and an MCP server. What it does not hand an agent is a machine of its own.",
        theirPitch:
            "“Run 10+ parallel coding agents on your machine”: a macOS app that runs any CLI agent in its own git worktree, with terminals, a diff viewer and an in-app browser around it.",
        verdict: [
            "Feature for feature this is the nearest neighbour intentic has, and the overlap is real rather than superficial. If you are on a Mac and your agents need only the toolchain that Mac already carries, Superset does the job and does it well.",
            "Underneath, the two make opposite bets. Superset's agents run in your local environment, tuned by per-workspace setup scripts. Each intentic agent gets a container built from an image you approve, with credentials for your systems kept inside it.",
            "The second split is what “remote” means. Superset reaches another machine through Superset Relay, on a paid plan and inside an organisation. An intentic sandbox dials its own tunnel out to your browser, and the platform stays off that path — it holds your account, where your sandbox is and who you shared it with, never your code, your agent's work or the credentials inside it.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Agents run in parallel on hardware you own, each in its own git worktree, on the subscription you already pay for — neither product proxies a model call or marks one up. Both put a diff between the agent and your tree, both keep a terminal next to it, and both can start a session with nobody watching.",
        },
        differences: [
            {
                title: "A container, not the Mac as you left it",
                body: "Superset shapes a workspace with setup, teardown and run scripts, but the tools those scripts reach for are whatever is installed on your machine. In intentic the machine is the artefact: an overlay Dockerfile you read and approve, so the agent that needs psql and a headless browser has them and your laptop does not.",
            },
            {
                title: "Credentials the agent operates, not credentials in your shell",
                body: "Capabilities wire a sandbox to GitHub, GitLab, PostgreSQL, Sentry, Discord, SSH, a VPN or any MCP server. Each ships the skill that teaches the agent to drive that system and keeps its credential inside the sandbox, injected into the agent's environment per turn, with no path from the platform to it.",
            },
            {
                title: "Remote, without a relay in the middle",
                body: "Superset Relay is a service that routes traffic between your devices, and remote hosts sit on a paid plan with an organisation around them. An intentic sandbox opens nothing inbound and dials out; your browser holds the token that commands it, and the platform sits off that path entirely.",
            },
            {
                title: "Where the machine doing the work can be",
                body: "Superset ships for macOS today, with Windows and Linux still to come. A sandbox is Docker, so the work can happen on a workstation, a VPS, a Mac or a Windows PC — and that machine need not be the one you are looking at.",
            },
            {
                title: "Scheduled, or woken by what happened",
                body: "Superset's automations run agent sessions on a schedule. intentic's also start on a push, an alert, a payment, an email or a chat message, each with its own transcript and an optional guard command — and a chat thread keeps its conversation, so a follow-up reaches the agent that answered.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your Mac, in your local environment" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS; Windows and Linux not yet shipped" },
            {
                label: "Which agents it runs",
                intentic: "5 native harnesses, plus any ACP agent as a capability",
                them: "any CLI agent at all, a dozen of them with presets",
                theirs: true,
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "per-workspace setup, teardown and run scripts",
            },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "your local shell" },
            {
                label: "Reaching another machine",
                intentic: "a private tunnel the sandbox dials out; nothing inbound is opened",
                them: "Superset Relay, on a paid plan and an organisation",
            },
            {
                label: "Starts on an event",
                intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events",
                them: "automations on a schedule",
            },
            {
                label: "Driving it from other software",
                intentic: "a CLI, an ACP bridge for any editor, and scoped control tokens over HTTP",
                them: "a CLI, a TypeScript SDK and an MCP server",
                theirs: true,
            },
            {
                label: "Previewing what the agent built",
                intentic: "ports detected and attributed per repo, dev servers live in an iframe",
                them: "an in-app browser with per-workspace port detection",
            },
            { label: "Native desktop app", intentic: "browser workspace, plus two-way desktop sync", them: "a real macOS app", theirs: true },
            {
                label: "Licence",
                intentic: "MIT throughout — sandbox, platform and CLI",
                them: "source available under the Elastic License 2.0",
            },
        ],
        pickThem:
            "You work on a Mac, the tools your agents need are already installed on it, and you want the most finished native surface for running ten at once — with an SDK and an MCP server so your other agents can drive it. Superset is further along at exactly that, and one person working locally is inside its free tier.",
        meta: {
            title: "intentic vs Superset · the same surfaces, a different machine",
            description:
                "Superset runs any CLI agent in its own worktree on your Mac. intentic runs each in a container you configure, credentials kept inside it, reached over a tunnel the sandbox dials out.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "t3-code",
        name: "T3 Code",
        url: "https://t3.codes/",
        navLabel: "vs T3 Code",
        menuBlurb: "Control the agents on your machine, or give them one",
        family: "orchestrators",
        heading: "T3 Code controls the agents on your machine. intentic gives each agent a machine.",
        sub: "Of everything on this page, this shares the most premises: your subscription, your hardware, MIT top to bottom, and a real answer for your phone. What is left over is the layer under the agent.",
        theirPitch:
            "“The open-source control plane for coding agents.” Orchestrate Claude Code, Codex, OpenCode, Cursor and Grok from one surface. Bring your own subscription. Fork the whole thing.",
        verdict: [
            "T3 Code drives harnesses that are already installed and signed in on one computer, from a desktop app, a web app and native iOS and Android apps that all talk to the server running there. It is MIT, it is free, and it asks for nothing you are not already paying for.",
            "intentic agrees with all of that and then changes what an agent inherits. Instead of your machine as it stands, it gets a container built from an image you approve, capabilities that hand it your systems, and events that can start it while you are asleep.",
            "So the question is not which surface is nicer. It is whether the work you want done needs an environment you can change.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Bring your own subscription: nothing resold, metered or capped by either of us. The harness is a choice rather than a lock-in, and switching it mid-thread is ordinary. Both are MIT — ours to the last line, the platform included — so you can read the whole of what wraps your agent before you trust it. And an agent you started at your desk should be answerable from your pocket.",
        },
        differences: [
            {
                title: "What the agent inherits",
                body: "T3 Code launches the CLIs installed on the computer running its server, so an agent's reach is your reach: your PATH, your logins, your installed clients. In intentic the agent's machine is an image, extended by an overlay Dockerfile you approve, and two agents on one host can have entirely different toolchains.",
            },
            {
                title: "Systems, not just files",
                body: "Capabilities wire a sandbox to GitHub, PostgreSQL, Sentry, Stripe, Discord, SSH and MCP servers, each keeping its credential inside. That is the difference between an agent that hands you a patch and one that can close the loop itself.",
            },
            {
                title: "Two ways to be reachable",
                body: "T3 Code pairs a device with a token over your LAN or your own tailnet, which depends on nobody. An intentic sandbox dials a private tunnel outward instead, so there is no network to arrange and the host can sit somewhere you have no route to.",
            },
            {
                title: "Isolation that is not a per-thread decision",
                body: "In T3 Code a thread takes a branch, and a worktree when you ask for one. Here every agent is cut its own worktree the moment it starts, never on request, and landing replays its delta onto your tree as ordinary git changes you can stage, amend or revert.",
            },
            {
                title: "Running when nobody is watching",
                body: "Automations start a fresh session on a schedule, a push, an alert, a payment, an email or a chat message, gated by a guard command you write. A control plane runs the threads you open.",
            },
        ],
        table: [
            { label: "What it is", intentic: "the machine an agent works on", them: "a control surface for the agents on your machine" },
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your machine, against your local checkout" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS, Windows and Linux" },
            {
                label: "Harnesses",
                intentic: "Claude Code, Codex, Grok, Kimi Code or Google, plus any ACP agent",
                them: "Claude Code, Codex, Cursor, Grok and OpenCode",
            },
            {
                label: "On a phone",
                intentic: "the workspace on your home screen, with push notifications",
                them: "native iOS and Android apps",
                theirs: true,
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your machine, as it already is",
            },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "your shell, one login per harness" },
            {
                label: "How you reach it from elsewhere",
                intentic: "a private tunnel the sandbox dials out; nothing inbound is opened",
                them: "a pairing token over your LAN or your own tailnet",
            },
            { label: "Isolation", intentic: "one git worktree per agent, never on request", them: "a branch per thread; a worktree when you ask" },
            {
                label: "Starts on an event",
                intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events",
                them: "you start each thread",
            },
            { label: "Setup", intentic: "Docker, a Google account, one pasted command", them: "npx t3, or one desktop app", theirs: true },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "MIT throughout" },
        ],
        pickThem:
            "Everything your agents need is already installed and signed in on the computer you use, you want native iOS and Android rather than a browser tab, and you would rather run one MIT app — no container runtime, no account, no platform anywhere — than configure an environment.",
        meta: {
            title: "intentic vs T3 Code · a control plane, or the machine under it",
            description:
                "T3 Code drives the harnesses installed on your computer, from desktop, web and phone. intentic gives each agent a container: an image you approve, credentials kept inside it.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "synara",
        name: "Synara",
        url: "https://www.trysynara.com/",
        navLabel: "vs Synara",
        menuBlurb: "Nine agent runtimes in one window, or one machine each",
        family: "orchestrators",
        heading: "Synara gives nine agent runtimes one window. intentic gives one agent a whole machine.",
        sub: "Both are free, local-first and fully open source, both isolate work in git worktrees, and neither goes near your tokens. They spend their effort at opposite ends of the same stack.",
        theirPitch:
            "“The command center for agentic development”: a local-first desktop app that runs Claude, Codex, OpenCode, Cursor, Antigravity, Grok, Kilo Code, Pi or Droid with the account you already use.",
        verdict: [
            "Synara invests in breadth at the top: nine agent runtimes, split chats, terminals, browser previews, diffs, worktrees and a one-click pull request, in one desktop window with nothing to sign up for.",
            "intentic invests in depth at the bottom: whichever harness you pick gets a container built from an image you approve, capabilities that hand it your repo, your database and your error tracker, and an event that can start it without you.",
            "On runtime count Synara simply wins. If the machine you already have carries what your work needs, that breadth — plus not running Docker — is a real reason to choose it.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Both run on hardware you own, on subscriptions you already pay for, with no proxy and no markup in between. Work is isolated in git worktrees so parallel agents cannot write over each other, nothing reaches your tree before you have read a diff, and both are MIT and public — ours whole, platform included.",
        },
        differences: [
            {
                title: "Breadth at the top, or depth underneath",
                body: "Synara's answer to “which agent” is nine of them, with a session's context following you when you hand it to another. intentic's answer is five natively plus any ACP agent, and then everything under whichever one you picked.",
            },
            {
                title: "The environment is a file you approve",
                body: "Synara runs the runtimes authenticated on your machine, so what an agent can do is what you happen to have installed. Here the machine is an image, extended by an overlay Dockerfile you read first, and it is per agent rather than per person.",
            },
            {
                title: "Systems, not just files",
                body: "Capabilities wire a sandbox to GitHub, PostgreSQL, Sentry, Stripe, Discord, SSH and MCP servers, each with its credential kept inside. That is what lets an agent finish a job rather than stall at the point where it needs the staging database.",
            },
            {
                title: "Reaching the work from elsewhere",
                body: "Synara's remote access is self-hosted over your own network, behind a token you control. An intentic sandbox dials a private tunnel outward, so the machine doing the work can be a VPS you never sit at, on a network you are not on.",
            },
            {
                title: "Running when the window is closed",
                body: "Automations start a fresh session on a schedule, on a webhook — a push, an alert, a payment — on a live event from CI, email or chat, or on the workspace's own work: a turn settling, work landing, checks breaking. Each carries its own transcript. And a teammate invited by email reaches the same sandbox, signed in as themselves.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your machine, against your local checkout" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS, Windows and Linux" },
            {
                label: "Agent runtimes",
                intentic: "5 native harnesses, plus any ACP agent as a capability",
                them: "9: Claude, Codex, OpenCode, Cursor, Antigravity, Grok, Kilo Code, Pi, Droid",
                theirs: true,
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your machine, as it already is",
            },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "your machine, one login per runtime" },
            {
                label: "Shipping the change",
                intentic: "a diff reader you tick through, then land onto your tree, hold on the branch or discard",
                them: "diff review, then a one-click pull request with a generated title and body",
                theirs: true,
            },
            {
                label: "How you reach it from elsewhere",
                intentic: "a private tunnel the sandbox dials out; nothing inbound is opened",
                them: "self-hosted over your own network, behind a token you control",
            },
            {
                label: "Native desktop app",
                intentic: "a native Windows and Linux app; browser workspace anywhere, plus two-way desktop sync",
                them: "a native desktop app",
                theirs: true,
            },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "you open the app" },
            { label: "Sharing with a teammate", intentic: "invite by email; grants enforced by the daemon", them: "one person, one machine" },
            { label: "Account required", intentic: "a Google sign-in for the hosted workspace", them: "none at all", theirs: true },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "MIT" },
        ],
        pickThem:
            "You want the widest choice of agent runtime in one window — Antigravity, Kilo Code, Pi and Droid alongside the usual three — on a machine that already carries the tools your work needs, with no account, no container runtime and no platform anywhere in the path.",
        meta: {
            title: "intentic vs Synara · nine runtimes, or a machine each",
            description:
                "Synara runs nine agent runtimes in one local-first desktop window. intentic runs each agent in a container you configure, with your systems wired in and events that wake it.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "cloud-agents",
        name: "cloud agent platforms",
        url: "https://www.cognition.ai/devin",
        navLabel: "vs cloud agents",
        menuBlurb: "Devin, Codex cloud, Jules: the one real either/or",
        family: "cloud",
        heading: "The only comparison on this page that is actually a choice.",
        sub: "Devin, Codex cloud, Claude Code on the web, Jules, Replit Agent. Everything else here composes with intentic. These do not, because they answer one question differently: whose computer holds your source.",
        theirPitch:
            "A hosted agent you give a task and a repository to. It runs on the vendor's infrastructure, in the vendor's sandbox, and hands you a pull request.",
        verdict: [
            "The experience is genuinely good and the setup cost is genuinely zero. That is the trade: your code, your keys and your production access, living in someone else's sandbox for the duration.",
            "intentic's position is that the browser experience was never the part that required giving that up. The sandbox runs on hardware you own, and the platform sits off the command path — and every line of both is MIT in one public repo, so that is a claim you can check rather than one you have to take.",
        ],
        overlap: {
            title: "Where we agree",
            body: "An agent should be supervised from a browser, not a terminal. It should run several jobs in parallel, show its plan before it acts and its diff before anything lands. Every one of those is a cloud-agent idea and intentic took all of them.",
        },
        differences: [
            {
                title: "Custody, stated architecturally",
                body: "Your browser holds the token that commands the sandbox; the platform never does. It stores identity, a URL, billing state, grants and the connection secrets that pair a browser to a sandbox — encrypted at rest under a key the platform holds. What it never stores is your code, your prompts or your capability credentials: those live only inside the sandbox.",
            },
            {
                title: "Real access, safely",
                body: "An agent usually stalls at 80% because it cannot reach what it needs: the staging database, the error tracker, the box the service runs on. Capabilities give it those, with the credential kept inside a sandbox you own.",
            },
            {
                title: "Your subscription, no meter",
                body: "Cloud platforms bill you for the model and for the machine, usually with a markup on both. intentic runs on the account you already pay for, on hardware you already own, for a flat fee that never meters tokens.",
            },
            {
                title: "An exit that is not a migration",
                body: "Your repos are ordinary git on your own disk. intentic is MIT end to end — sandbox, CLI and platform, developed in one public repo — and the CLI drives from the command line without ever signing in. Leaving is deleting an account, not extracting a workspace.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "your hardware", them: "the vendor's infrastructure" },
            { label: "Who can read your source", intentic: "you; the platform has no path to it", them: "the vendor, for the duration of the run" },
            { label: "Where your service credentials sit", intentic: "inside your sandbox", them: "in the vendor's secret store" },
            { label: "Model billing", intentic: "your own subscription, never metered by us", them: "the vendor's plan, usually with a markup" },
            { label: "Compute billing", intentic: "hardware you already own", them: "the vendor's, metered or bundled" },
            {
                label: "Supervision",
                intentic: "fleet board, plan mode, diff review, transcripts",
                them: "fleet board, plan mode, diff review, transcripts",
            },
            { label: "Setup", intentic: "Docker, a Google account, one pasted command", them: "connect a repo; nothing to host", theirs: true },
            { label: "Elastic capacity", intentic: "bounded by the machine you provide", them: "as many agents as you will pay for", theirs: true },
            {
                label: "Enterprise paperwork",
                intentic: "no certifications yet; the whole system is MIT and auditable line by line",
                them: "established vendors with the certifications",
                theirs: true,
            },
        ],
        pickThem:
            "You would rather not provide a machine, the repository is not sensitive, your procurement process needs a vendor with the certifications already in hand, and you want to burst to fifty agents on a Tuesday without owning fifty cores.",
        meta: {
            title: "intentic vs Devin and cloud agents · whose machine runs it",
            description:
                "Cloud agent platforms run on the vendor's infrastructure with your source and credentials inside. intentic keeps the same browser experience with the sandbox on hardware you own.",
            datePublished: PUBLISHED,
        },
    },
];

export const comparePage = (slug: string): ComparePage | undefined => comparePages.find((page) => page.slug === slug);

export const familyPages = (id: string): ComparePage[] => comparePages.filter((page) => page.family === id);

/* The hub's own copy. It leads with the taxonomy rather than with us, because the reader's question is
 * "which of these things are you" and answering it first is what makes the rest credible. */
export const compareIndex = {
    eyebrow: "Compare",
    heading: "Most of these are not competitors.",
    sub: "“How does this compare to X?” is the question we get most. For four out of five values of X, the honest answer is that X is something intentic runs or something you keep alongside it.",
    axes: {
        heading: "Two questions sort the entire field",
        items: [
            {
                title: "Whose machine does the agent run on?",
                body: "Yours, or a vendor's. It decides who can read your source, where your service credentials sit, and what a breach at the vendor is worth. It is the only line on this page nobody can be on both sides of.",
            },
            {
                title: "How much of the agent's environment can you change?",
                body: "Everywhere else the prompt is the layer you get. The layers under it, the image and the systems and the context, are what decide whether it can finish a job.",
            },
        ],
    },
    correction: {
        title: "Found something out of date?",
        body: "These describe other people's products and they ship as fast as we do. Every claim is checkable on the vendor's own site; where we have it wrong, open an issue.",
        cta: "Report an inaccuracy",
    },
    meta: {
        title: "How intentic compares · Conductor, Superset, T3 Code, Synara, Cursor",
        description:
            "Where intentic sits among agent CLIs, AI editors, local orchestrators — Conductor, Superset, T3 Code, Synara — and cloud platforms, with the case for each.",
        datePublished: PUBLISHED,
    },
};
