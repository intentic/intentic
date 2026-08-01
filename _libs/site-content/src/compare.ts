/* The comparison shelf: "how does intentic compare to X?", answered honestly and once per X.
 *
 * The question arrives constantly and the naive answer — a feature matrix where every row is a tick for us —
 * is the fastest way to lose the credibility the rest of the site is built on. So the shelf is organised
 * around a fact that is true and disarming: MOST of the tools people name are not competitors. Five of them
 * are agent harnesses this product runs (`_libs/capability-catalog/src/index.ts`, the ACP cards), the editors
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
        body: "A harness turns a model into an agent in your terminal: it holds the loop, the tools, and the permission prompts. It is the engine, not the garage. intentic is what one runs inside — five are built in and switchable per turn, and anything speaking the Agent Client Protocol is one capability away, OpenCode and Gemini CLI included. Asking which to pick is like asking whether to use a compiler or an IDE.",
        examples: ["Claude Code", "Codex", "Grok", "Kimi Code", "Gemini CLI", "OpenCode", "Goose", "Qwen Code"],
    },
    {
        id: "editors",
        label: "AI editors",
        verdict: "keep yours",
        body: "An AI editor puts you at the keyboard with a model helping — completion, inline edits, a chat that knows the file you are in. intentic puts the agent at the keyboard and you in review. Different jobs, and the same files: desktop sync mirrors the sandbox's workspace onto your own machine both ways, so your editor opens what an agent just wrote. Zed and JetBrains go further and drive a sandbox agent directly over ACP.",
        examples: ["Cursor", "Windsurf", "VS Code + Copilot", "Zed", "JetBrains AI"],
    },
    {
        id: "orchestrators",
        label: "Local agent orchestrators",
        verdict: "same instinct, wider scope",
        body: "The closest neighbours, and the ones that got the ownership question right: several agents at once, each on its own git worktree, on your hardware and your own subscription. Where intentic keeps going is everything around the agent — the image its tools are really installed in, the credentials it operates your systems with, the events that wake it while you sleep, the browser and phone it is reachable from, the teammates you share it with.",
        examples: ["Conductor", "Nimbalyst", "Crystal", "Vibe Kanban", "Sculptor"],
    },
    {
        id: "cloud",
        label: "Cloud agent platforms",
        verdict: "the opposite trade",
        body: "The only genuine either/or on this page. They give you a good remote experience by running the agent on their infrastructure, which means your source, your tokens and often your production credentials sit in their sandbox. intentic gives you the same remote experience with the sandbox on hardware you own: the platform stores your identity and a URL, sits off the command path, and has no route to your code.",
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
        sub: "Conductor and intentic answer the same first question — how do you run five agents at once without them writing over each other — and then diverge on what an agent needs around it.",
        theirPitch: "“Run parallel Claude Code, Codex, and Cursor agents in isolated workspaces on your Mac.”",
        verdict: [
            "Conductor is a native Mac app that orchestrates agents on the machine you are sitting at. It is good at that, it got there early, and if running several agents on your own laptop is the whole job it may be all you need.",
            "intentic gives each agent a container of its own: an image you edit and approve, credentials it operates your systems with, events that wake it, and a browser — including a phone — that reaches it from anywhere over a private tunnel.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Agents run in parallel, each in its own git worktree, on your hardware, on the Claude or ChatGPT subscription you already pay for — and nothing merges until you have read the diff. Neither of us thinks your source belongs on a vendor's servers by default.",
        },
        differences: [
            {
                title: "A sandbox, not your laptop as it already is",
                body: "Conductor runs agents in your existing local environment, so what the agent can do is whatever you happen to have installed. In intentic each agent gets a container whose image is an overlay Dockerfile — a psql client, a headless browser, the language toolchain the job needs, really installed for that agent and not on your laptop. The agent can propose a line; it waits for you to read the diff and approve.",
            },
            {
                title: "Credentials the agent operates, not credentials in your shell",
                body: "Capabilities wire a sandbox to GitHub, PostgreSQL, Sentry, Stripe, Discord, an SSH host or any MCP server. The secret is written inside the sandbox and injected into the agent's environment each turn — denylisted from the file relay, never shown back to you, and with no path from the platform to it.",
            },
            {
                title: "The machine and the screen come apart",
                body: "The sandbox is Docker, so it runs on a Linux workstation, a VPS, a Mac or WSL2, and it dials out over a private tunnel your browser talks to. That means the machine doing the work does not have to be the machine you are looking at — a decision approved from a phone at 11pm is the same click it is at your desk.",
            },
            {
                title: "Agents that run when you are not there",
                body: "Automations wake an agent on a schedule, a push, a Sentry alert, a Stripe payment, an inbound email or a Discord message, each as a fresh session with its own transcript and an optional guard command that decides whether the run happens at all.",
            },
            {
                title: "Two different answers to “what about remote?”",
                body: "Conductor's is Pro's cloud workspaces — Vercel sandboxes in us-east-1 — and their own privacy note is straight about the consequence: for cloud workspaces they must store your session inputs and outputs on their servers. intentic's answer is that your machine was already remote; it just needed a tunnel and a browser.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your Mac — or their cloud workspace on Pro" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows via WSL2", them: "macOS" },
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
            { label: "Native desktop app", intentic: "browser workspace, plus two-way desktop sync", them: "a real macOS app", theirs: true },
            {
                label: "A machine you do not have to provide",
                intentic: "you bring the hardware",
                them: "cloud workspaces, nothing to host",
                theirs: true,
            },
            { label: "Source you can read", intentic: "sandbox and CLI are MIT on GitLab", them: "closed source" },
        ],
        pickThem:
            "You work on one Mac and want a native app rather than a browser, your agents only ever need the toolchain already on that Mac, and you would rather rent a cloud workspace than provide a machine.",
        meta: {
            title: "intentic vs Conductor — parallel agents, compared",
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
        sub: "This is the comparison that most often ends in “both”. They are different jobs on the same files, and there is a mechanism that makes running them together real rather than diplomatic.",
        theirPitch:
            "“Your coding agent for building ambitious software” — an AI editor, with desktop agents, cloud agents, a CLI and automations around it.",
        verdict: [
            "Cursor's centre of gravity is the cursor in a file: completion, inline edits, a model that knows what you are looking at. Everything it has added since is arranged around that.",
            "intentic's centre of gravity is a board of agents sorted by which one needs a decision from you. The editor exists so you can read what they wrote, not so you can out-type them.",
            "If you want the model to help you write, use Cursor. If you want to run five agents and review their diffs, that is this. Keeping both is the normal outcome, not a compromise.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Both run agents in parallel, both make you read a diff before anything is yours, and both have automations that start work on a schedule or an event. Cursor's inline editing has no equivalent here and is not trying to get one.",
        },
        differences: [
            {
                title: "Whose computer the background agent uses",
                body: "Cursor's cloud agents run on Cursor's machines — that is what makes them zero-setup. intentic's agents run in a container on yours, reached over a tunnel it dials out, with the platform holding your identity and the sandbox's URL and nothing else. Same remote experience, opposite custody.",
            },
            {
                title: "The environment is a file you approve",
                body: "In an editor the agent inherits your machine. Here each agent has an image of its own, extended by an overlay Dockerfile you read and approve before a rebuild applies it, plus capabilities that wire it to your repos, databases and services with the credential kept sandbox-side.",
            },
            {
                title: "Whose bill the tokens land on",
                body: "intentic runs on the Claude, ChatGPT, SuperGrok, Kimi or Google account you already pay for, connected once with a sign-in code, and never meters or marks up model usage — the spend ledger lives in your sandbox because it is your subscription being spent.",
            },
            {
                title: "Supervision as a surface, not a notification",
                body: "Ten agents need somewhere to be ranked. The fleet board has an Attention lane an agent moves itself into with the reason on the card — a question, a plan waiting for approval, a land conflict — so a fleet reads as a short list of things only you can do.",
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
            { label: "Model billing", intentic: "your own subscription, no metering by us", them: "Cursor's plans, or your API keys" },
            {
                label: "Supervising many agents",
                intentic: "a fleet board with an Attention lane",
                them: "an agents list in the editor and on the web",
            },
            {
                label: "Editor maturity",
                intentic: "a workspace editor for reading and small edits",
                them: "a full IDE, forked from VS Code",
                theirs: true,
            },
            { label: "Source you can read", intentic: "sandbox and CLI are MIT on GitLab", them: "closed source" },
        ],
        together: {
            title: "Run both — and mean it",
            body: "Turn on desktop sync and the sandbox's workspace mirrors into a folder on your own machine, two ways and in near real time. Open that folder in Cursor and you are editing the same tree your agents work in: they land a diff, your editor sees it. Zed and JetBrains can go one step further with @intentic/acp-bridge and drive a sandbox agent from inside the editor's own agent panel.",
        },
        pickThem:
            "The work is you typing — reading a large unfamiliar codebase, refactoring by hand with the model completing around you, or living inside one repo all day. That is a different job, and Cursor is very good at it.",
        meta: {
            title: "intentic vs Cursor — the editor and the agent workspace",
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
        sub: "Claude Code, Codex, Grok, Kimi Code and Gemini are harnesses — the loop, the tools, the permission prompts. This is not a choice between them and intentic, because intentic runs them.",
        theirPitch: "Anthropic's coding agent for your terminal — and the same shape as Codex, Grok, Kimi Code and Gemini CLI.",
        verdict: [
            "Pick a harness the way you pick a compiler: on the model behind it and how it behaves. Then the question of where it runs, what it can reach and who is watching it is still entirely open — and that is the question intentic answers.",
            "Every conversation here picks its harness from the same five, switchable per turn along with the model and reasoning effort. The terminal is still there, in the workspace, sharing one tmux server with the agent's own shell commands.",
        ],
        overlap: {
            title: "Where we agree",
            body: "It is the same agent, running on the same subscription of yours, on the same files. Nothing is proxied through us and no tokens are marked up. If you point intentic at your repo you get Claude Code doing what Claude Code does — with a fleet board, a diff reader and a spend ledger around it.",
        },
        differences: [
            {
                title: "One terminal, or a board of them",
                body: "A CLI is single-player and single-machine by construction: one conversation per window, one working tree, and whatever scrollback you have kept. The fleet board runs each agent on its own git worktree off your base commit, ranks them by which needs a decision, and shows model, branch, turns, tokens, dollars and diff stats on every card.",
            },
            {
                title: "Available from a browser, including a phone",
                body: "The sandbox dials out over a private tunnel and your browser talks to it. The same conversation — the running turn, its tool calls, the plan card, the approval buttons — is one tap away on a phone, which is the difference between an agent blocked overnight and one unblocked in ten seconds.",
            },
            {
                title: "An environment you can change",
                body: "A CLI inherits the machine it was launched on. Here the machine is an image: an overlay Dockerfile you read and approve, plus capabilities that install a real client and keep its credential inside the sandbox. The agent gains a skill for it on its next turn.",
            },
            {
                title: "Asleep when you are, or woken by events",
                body: "Automations start a fresh session on a schedule, a push, an alert, a payment, an email or a chat message, each with its own transcript and an optional guard command. A CLI runs when you run it.",
            },
            {
                title: "One index, one tmux, one tree",
                body: "The workspace search box and the agent's Bash calls hit the same iq index. Your terminal and its shell commands share one tmux server. What it edits is what you open — not a viewer synchronised with the agent's view, because there is only one view.",
            },
        ],
        table: [
            { label: "The agent itself", intentic: "Claude Code, Codex, Grok, Kimi Code or Google, per turn", them: "Claude Code" },
            { label: "Whose subscription pays", intentic: "yours, connected once, never metered by us", them: "yours" },
            {
                label: "Conversations at once",
                intentic: "as many as you have roles, each on its own worktree",
                them: "one per terminal window, one working tree",
            },
            {
                label: "Where you drive it from",
                intentic: "any browser, phone included, over a private tunnel",
                them: "the terminal on that machine",
            },
            {
                label: "Reviewing changes",
                intentic: "a split or unified diff reader with comments, then land or discard",
                them: "git, in your own terminal",
            },
            { label: "Cost visibility", intentic: "a ledger by day, provider, account, model and agent", them: "per-session totals" },
            { label: "Starts on an event", intentic: "automations: cron, webhook, push, alert, email, chat", them: "you start it" },
            { label: "Setup", intentic: "Docker, a Google account, one pasted command", them: "one npm install, nothing else", theirs: true },
            {
                label: "Works with no account at all",
                intentic: "the MIT CLI does; the hosted workspace needs a sign-in",
                them: "yes, just your Anthropic login",
                theirs: true,
            },
        ],
        together: {
            title: "You are already running it",
            body: "Claude Code is the default harness inside every intentic sandbox, and the sandbox and CLI that execute on your machine are MIT on GitLab — so you can read exactly what wraps your agent before you trust it with anything, and drive a sandbox from the CLI without ever signing in to the hosted app.",
        },
        pickThem:
            "You live in one terminal on one machine, you are happy starting each session yourself, and you need none of the fleet, the browser, the capabilities or the automations. The bare CLI is excellent and this product does not pretend otherwise.",
        meta: {
            title: "intentic vs Claude Code — the CLI and the workspace around it",
            description:
                "Claude Code is a harness; intentic is what it runs inside. A fleet board, a browser you reach from a phone, an editable sandbox image, and automations — on the same subscription.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "opencode",
        name: "OpenCode",
        url: "https://opencode.ai/",
        navLabel: "vs OpenCode",
        menuBlurb: "Add it as a provider — it is a capability here",
        family: "harnesses",
        heading: "You do not have to choose. OpenCode is a capability here.",
        sub: "OpenCode is an open-source agent that speaks the Agent Client Protocol. intentic's catalog has a card for exactly that, so it becomes one more provider in the chat picker — its own models, its own tools, its own config.",
        theirPitch:
            "“The open source AI coding agent” — a terminal, desktop and IDE agent with LSP integration, parallel sessions and 75+ model providers.",
        verdict: [
            "OpenCode is a harness, in the same category as Claude Code and Codex: it holds the agent loop and talks to whichever model you point it at. intentic is the environment a harness runs in.",
            "So the honest answer is not a comparison. Install the OpenCode capability, and “opencode acp” becomes a provider row alongside Claude Code and Codex — running inside the sandbox, on its own credentials, with the fleet board, diff review and spend ledger around it.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Both are open source and mean it — OpenCode's agent, and the intentic sandbox and CLI that execute on your machine, MIT on GitLab. Both run on your own machine and your own accounts. Both refuse to sit between you and your model provider.",
        },
        differences: [
            {
                title: "A harness, not a workplace",
                body: "OpenCode gives you the agent: the loop, the LSP integration, the model routing, parallel sessions in a project. It does not give the agent a machine of its own, credentials for your systems, or an event that wakes it — because that is not what a harness is for.",
            },
            {
                title: "What ACP buys you here",
                body: "Any agent speaking the Agent Client Protocol over stdio becomes a chat provider in a sandbox: OpenCode and Gemini CLI have preset cards, and the custom card takes any command from the ACP registry — Goose, Qwen Code, whatever ships next. Tool calls, statuses, file locations and inline diffs all stream into the same chat surface.",
            },
            {
                title: "Model freedom, from two directions",
                body: "OpenCode's answer to provider lock-in is 75+ providers behind one agent. intentic's is five native harnesses on subscriptions you already hold, switchable per turn, plus every ACP agent as a capability. Installed together you get both, and the picker shows which account each row would spend.",
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
            { label: "Where it runs", intentic: "a Docker sandbox on your hardware", them: "your machine — terminal, desktop or IDE" },
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
            { label: "Starts on an event", intentic: "automations: cron, webhook, push, alert, email, chat", them: "you start it" },
            { label: "Licence", intentic: "MIT sandbox and CLI; the hosted platform is closed", them: "open source throughout", theirs: true },
        ],
        together: {
            title: "How to add it",
            body: "Capabilities → OpenCode (ACP). The card pre-fills the command as “opencode acp”, you supply whatever credentials its providers need, and it appears in the chat provider picker on the next turn. Nothing about your OpenCode config changes; it is the same binary, running in the sandbox instead of your shell.",
        },
        pickThem:
            "You want one open-source agent you can read end to end, pointed at any of seventy-five providers, in a terminal on the machine you are already using — and you do not need a sandbox, capabilities, a fleet or a browser around it.",
        meta: {
            title: "intentic vs OpenCode — or rather, OpenCode inside intentic",
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
        sub: "Nimbalyst and intentic share more than either shares with anything else on this page: local, open source, free to run, your own subscription, sessions in parallel on git worktrees, an extension system, a phone in your pocket.",
        theirPitch: "“Open-source visual workspace for coding agents. Build with Claude Code and Codex. Manage all the work around them.”",
        verdict: [
            "Nimbalyst builds outward toward the artefacts you and the agent work on together — markdown, mockups, Mermaid, Excalidraw, CSV, data models — each with a visual editor and red/green review, plus tasks and a session kanban.",
            "intentic builds outward toward the machine underneath the agent — the image its tools are installed in, the credentials it operates your systems with, the events that wake it, the tunnel that makes it reachable, the teammates you share it with.",
            "Neither is the other's lesser version. If your work is as much documents and diagrams as it is code, their direction is the useful one.",
        ],
        overlap: {
            title: "Where we agree",
            body: "Agents run locally on hardware you own, on the Claude Code or Codex subscription you already have. Sessions run in parallel with git worktree isolation. Changes are reviewed before they are yours. There is a mobile app for answering an agent that is blocked. Both projects are open source and both have an extension system rather than a fixed feature list.",
        },
        differences: [
            {
                title: "The environment layer",
                body: "Nimbalyst runs agents against your local checkout with your local tools. In intentic each agent has a container of its own, extended by an overlay Dockerfile you read and approve — so the agent that needs psql and a headless browser has them, and your laptop does not.",
            },
            {
                title: "Systems, not just files",
                body: "Capabilities wire a sandbox to GitHub, PostgreSQL, Sentry, Stripe, Discord, SSH hosts and MCP servers. Each installs a real client and stores its credential inside the sandbox, injected into the agent's environment per turn. That is what lets an agent close the loop on a job rather than hand you a patch.",
            },
            {
                title: "The machine does not have to be the screen",
                body: "Nimbalyst is a desktop app on the machine holding the code. intentic's sandbox dials out over a private tunnel and any browser reaches it, so the machine doing the work can be a VPS or a workstation you never sit at — and the same workspace opens on a phone.",
            },
            {
                title: "Running when nobody is watching",
                body: "Automations start a fresh session on a schedule, a push, a Sentry alert, a Stripe payment, an inbound email or a Discord message, gated by a guard command you write. An agent can also be invited into Discord and answer like a colleague.",
            },
            {
                title: "More than one person",
                body: "Invite a teammate by email and they reach the same sandbox from their own browser over their own tunnel, with grants enforced fail-closed by the daemon. Setup stays owner-gated, and revoking or leaving never requires a paid plan.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your machine, in your checkout" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows via WSL2", them: "macOS, Windows, Linux" },
            { label: "How you reach it", intentic: "any browser over a private tunnel", them: "a native desktop app, plus an iOS app", theirs: true },
            {
                label: "Visual editors for docs, mockups and diagrams",
                intentic: "a code editor and a diff reader",
                them: "markdown, mockups, Mermaid, Excalidraw, CSV, data models",
                theirs: true,
            },
            {
                label: "Task and plan tracking",
                intentic: "to-dos inside a running turn",
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
            { label: "Starts on an event", intentic: "automations: cron, webhook, push, alert, email, chat", them: "you start it" },
            { label: "Sharing with a teammate", intentic: "invite by email; grants enforced by the daemon", them: "one person, one machine" },
            { label: "Account required", intentic: "a Google sign-in for the hosted workspace", them: "none at all", theirs: true },
            { label: "Licence", intentic: "MIT sandbox and CLI; the hosted platform is closed", them: "MIT desktop and iOS apps", theirs: true },
        ],
        pickThem:
            "Your work is as much documents, mockups and diagrams as it is code, you want to review an agent's changes visually rather than as a unified diff, and you would rather install one desktop app with no account than run a sandbox.",
        meta: {
            title: "intentic vs Nimbalyst — two open-source agent workspaces",
            description:
                "Both are local, open source and free to run, with parallel sessions on git worktrees. Nimbalyst builds out the visual artefacts; intentic builds out the machine under the agent.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "cloud-agents",
        name: "cloud agent platforms",
        url: "https://www.cognition.ai/devin",
        navLabel: "vs cloud agents",
        menuBlurb: "Devin, Codex cloud, Jules — the one real either/or",
        family: "cloud",
        heading: "The only comparison on this page that is actually a choice.",
        sub: "Devin, Cursor's cloud agents, Codex cloud, Claude Code on the web, Jules, Replit Agent. Everything else here composes with intentic. These do not, because the question they answer differently is whose computer holds your source and your keys.",
        theirPitch:
            "A hosted agent you give a task and a repository to. It runs on the vendor's infrastructure, in the vendor's sandbox, and hands you a pull request.",
        verdict: [
            "The experience is genuinely good and the setup cost is genuinely zero. That is the trade being offered: your code, your model tokens and — the moment an agent needs to do anything real — your database URLs, your API keys and your production access, living in someone else's sandbox for the duration.",
            "intentic's position is that the browser experience was never the part that required giving that up. The sandbox runs on hardware you own and dials out over a private tunnel; the platform stores your identity and the sandbox's URL, sits off the command path, and cannot read your code or drive your daemon even if it wanted to.",
        ],
        overlap: {
            title: "Where we agree",
            body: "An agent should be supervised from a browser, not a terminal. It should run several jobs in parallel. It should show its plan before it acts and its diff before anything lands. It should be reachable from a phone. Every one of those is a cloud-agent idea and intentic took all of them.",
        },
        differences: [
            {
                title: "Custody, stated architecturally",
                body: "Your browser holds the token that commands the sandbox; the platform never does. What the platform stores is your identity, the sandbox's URL, billing state and the grants that let a teammate reach it — encrypted at rest with no decrypt path in the product. A breach reads a URL and reaches nothing.",
            },
            {
                title: "Real access, safely",
                body: "The reason an agent stalls at 80% is usually that it cannot reach the thing it needs: the staging database, the error tracker, the payment log, the box the service runs on. Capabilities give it those, with the credential kept inside a sandbox you own — which is a very different sentence from pasting the same credential into a vendor's dashboard.",
            },
            {
                title: "Your subscription, no meter",
                body: "Cloud platforms bill you for the model and for the machine, usually with a markup on both. intentic runs on the Claude, ChatGPT, SuperGrok, Kimi or Google account you already pay for, on hardware you already own, for a flat platform fee that never meters tokens.",
            },
            {
                title: "An exit that is not a migration",
                body: "Your repos are ordinary git on your own disk. The sandbox and CLI are MIT on GitLab and drive from the command line without ever signing in. Leaving is deleting an account, not extracting a workspace.",
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
                intentic: "a new product; read the MIT source instead",
                them: "established vendors with the certifications",
                theirs: true,
            },
        ],
        pickThem:
            "You would rather not provide a machine, the repository is not sensitive, your procurement process needs a vendor with the certifications already in hand, and you want to burst to fifty agents on a Tuesday without owning fifty cores.",
        meta: {
            title: "intentic vs Devin and cloud agents — whose machine runs it",
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
    sub: "“How does this compare to X?” is the question we get most, and for four out of five values of X the honest answer is that X is something intentic runs, or something you keep using alongside it. Here is the whole field, sorted, with the case for the other product written out wherever there is one.",
    axes: {
        heading: "Two questions sort the entire field",
        items: [
            {
                title: "Whose machine does the agent run on?",
                body: "Yours, or a vendor's. It decides who can read your source, where your service credentials sit, and what a breach at the vendor is worth. It is the only line on this page nobody can be on both sides of.",
            },
            {
                title: "How much of the agent's environment can you change?",
                body: "Everywhere else the prompt is the layer you get. The layers under it — the image its tools are really installed in, the systems it may reach, the context it loads every turn — are what actually decide whether it can finish a job.",
            },
        ],
    },
    correction: {
        title: "Found something out of date?",
        body: "These describe other people's products and they ship as fast as we do. Every claim here is checkable on the vendor's own site, and where we have it wrong we would rather know — open an issue and it gets fixed in the next build.",
        cta: "Report an inaccuracy",
    },
    meta: {
        title: "How intentic compares — Conductor, Cursor, Claude Code, OpenCode, Nimbalyst",
        description:
            "Where intentic sits among agent CLIs, AI editors, local orchestrators and cloud agent platforms — with the case for the other product written out for each.",
        datePublished: PUBLISHED,
    },
};
