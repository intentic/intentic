export interface LandingFact {
    title: string;
    body: string;
}

export interface LandingSectionIntro {
    eyebrow: string;
    heading: string;
    sub: string;
}

/** A labeled row of tags in the hero's specialized-agent card (e.g. "Environment" → toolchain). */
export interface AgentSpecRow {
    label: string;
    items: string[];
}

/** The hero visual: a shared environment with two operators — you, who can change every layer, and the agent that works inside it. */
export interface AgentSpec {
    name: string;
    role: string;
    rows: AgentSpecRow[];
    /** Top of the figure — you, the operator who can open and change any layer of the environment. */
    edit: string;
    /** Bottom of the figure — what the agent does inside that same environment (split on " · "). */
    outcome: string;
    /** The scale note under the outcome — one agent, or a whole fleet. */
    scale: string;
}

/** One side of the "a prompt vs the whole environment" comparison. */
export interface LandingContrastColumn {
    label: string;
    caption: string;
    points: string[];
}

/** One system the sandbox connects to — a node in the integrations hub-and-spoke. */
export interface IntegrationNode {
    name: string;
    category: string;
    /** A key in Landing.astro's brandLogos map: a simple-icons slug, or an in-house glyph (ssh/mcp). */
    logo: string;
}

/** One message in the "talk to it like a teammate" chat mock. */
export interface ChatMessage {
    author: string;
    text: string;
    time: string;
    /** Renders the AGENT badge + tinted bubble — the specialized agent replying in-thread. */
    agent?: boolean;
}

/** One participant in the shared-sandbox diagram — the owner, or an invited teammate. */
export interface SharingPerson {
    name: string;
    role: string;
    access: string;
    owner?: boolean;
}

/** One captioned product screenshot in the "see it in action" tour. */
export interface TourShot {
    src: string;
    alt: string;
    title: string;
    body: string;
}

export interface LandingContent {
    meta: { title: string; description: string };
    hero: {
        headlineLines: string[];
        subhead: string;
        chips: string[];
        spec: AgentSpec;
    };
    // The product tour: real screenshots of the workspace — the fleet board, the chat, diff review, and the
    // integrations catalog — so a visitor sees exactly what they'd be using, not just diagrams.
    tour: LandingSectionIntro & {
        hero: { src: string; alt: string; caption: string };
        chat: TourShot;
        shots: TourShot[];
    };
    contrast: LandingSectionIntro & { prompt: LandingContrastColumn; agent: LandingContrastColumn };
    anatomy: LandingSectionIntro & { pillars: LandingFact[] };
    // The sandbox-container figure: an agent on a machine you own, its tools installed and context loaded.
    sandbox: LandingSectionIntro & { boundary: string; agent: { name: string; role: string }; layers: AgentSpecRow[] };
    // The integrations hub-and-spoke: the sandbox at center, the systems it operates around it.
    integrations: LandingSectionIntro & { hubLabel: string; hubSub: string; nodes: IntegrationNode[]; note: string };
    workforce: LandingSectionIntro & { moments: LandingFact[] };
    // The conversation mock: assign work to the agent in Discord and it replies like a colleague.
    teammate: LandingSectionIntro & { surface: string; thread: ChatMessage[]; note: string };
    ownership: LandingSectionIntro & { facts: LandingFact[] };
    // The sharing diagram: an owner configures one sandbox; invited teammates share it over their own tunnels.
    sharing: LandingSectionIntro & { people: SharingPerson[]; sandboxLabel: string; sandboxSub: string; note: string };
    // The company teaser: a fleet of specialized agents (one per role/team) + the services they share — links to the full docs reference architecture.
    company: LandingSectionIntro & { teams: string[]; sharedServices: string[]; cta: string };
    economics: LandingSectionIntro & { accounts: { name: string; detail: string }[]; points: string[] };
    connect: LandingSectionIntro & { steps: LandingFact[]; commandNote: string };
    finalCta: { heading: string; sub: string };
}

// One thesis, told once: this is one workspace with two kinds of operator — you and your agents — and
// every layer of the environment they work in is visible and yours to change. Elsewhere the prompt is
// the only editable part; here it's the image the tools are installed in, the systems the agent may
// reach, and the context it loads each turn. Every claim maps to a shipping mechanism: environment
// overlays, capabilities/connectors, agent plugins/skills, isolated worktrees + land, sandboxes
// (Pro = many), and automations.
export const landingContent: LandingContent = {
    meta: {
        title: "intentic — A shared IDE for you and your agents",
        description:
            "A shared IDE for you and your agents. Every agent gets its own sandbox on hardware you own — its dev-tools really installed, wired to your systems, its context curated for one job — and you can see and change every layer of it. Works with Claude Code, Codex, Grok, Kimi Code, and Gemini. Free to start.",
    },
    hero: {
        headlineLines: ["The IDE you share", "with your agents."],
        subhead:
            "Everyone else lets you edit the prompt. intentic lets you see and change the whole environment your agents work in — the dev-tools really installed, the systems they can reach, the context they load every turn. Run one, or ten in parallel, on hardware you own.",
        chips: ["Free plan", "Bring your own agent", "Runs on your hardware"],
        spec: {
            name: "release-captain",
            role: "Owns the weekly release",
            rows: [
                { label: "Environment", items: ["node 24", "pnpm", "docker", "psql"] },
                { label: "Connected", items: ["GitHub", "Sentry", "Discord", "prod db · read"] },
                { label: "Context", items: ["repo: platform", "6 skills", "release runbook", "house style"] },
            ],
            edit: "See and change every layer of it — nothing here is fixed.",
            outcome: "cuts the release · drafts the changelog · watches the deploy",
            scale: "one agent, or ten in parallel",
        },
    },
    tour: {
        eyebrow: "The product",
        heading: "This is the actual workspace.",
        sub: "Not a chat box bolted onto a model — a real IDE for a fleet of agents. Autonomy still needs a human in the loop: you configure each agent's context, watch every run, drive one, and review its diffs before anything lands. That's what the workspace is for. Works with Claude Code, Codex, Grok, Kimi Code, and Gemini.",
        hero: {
            src: "/assets/product/agents-fleet.png",
            alt: "The intentic agent fleet board — a kanban of running agents grouped into Attention, Active and Finished lanes, each card showing its model, branch, cost and diff stats.",
            caption:
                "The fleet board — every agent on its own isolated branch, sorted by what needs you. Run a whole team in parallel; finished work lands in your workspace.",
        },
        chat: {
            src: "/assets/product/chat.png",
            alt: "The intentic chat surface on mobile: a Stripe-billing task with Read, Bash and Edit tool calls, a live to-do checklist, and the agent's reply.",
            title: "Chat that does the work",
            body: "Talk to it like a coworker. It reads files, runs commands, and edits code — every tool call and to-do visible as it works. Switch between Claude, Codex, Grok, Kimi, and Gemini mid-conversation, on your own subscription.",
        },
        shots: [
            {
                src: "/assets/product/agent-review.png",
                alt: "The isolated diff review: six changed files with per-file line stats, a Land now button, and the agent's live conversation docked alongside.",
                title: "Review the diff, then land it",
                body: "Each agent works on its own branch, so nothing touches your tree until you say so. See the full diff across every repo and land it in one click — or discard it and keep going.",
            },
            {
                src: "/assets/product/capabilities.png",
                alt: "The capability catalog: Docker, Stripe, SSH, VPN, Reddit, X, YouTube, MCP servers and Claude plugins, each with a short description.",
                title: "Wire in your systems",
                body: "A catalog of capabilities — GitHub, Postgres, Stripe, SSH, Docker, MCP servers, Claude plugins — added in a click. The credential is stored inside the sandbox and the agent operates the service from chat.",
            },
            {
                src: "/assets/product/workspace.png",
                alt: "The workspace: a file tree beside a syntax-highlighted editor showing a Stripe checkout module.",
                title: "A real editor and terminal",
                body: "Browse the tree, open files, run the terminal, watch panels come up on live preview URLs. The sandbox is a full workspace on a machine you own — not a toy.",
            },
            {
                src: "/assets/product/sandbox.png",
                alt: "The sandbox hub: the sandbox name, online status, its URL, agent account and capabilities at a glance.",
                title: "One sandbox, fully yours",
                body: "Every agent runs in its own container on your hardware, reached from your browser over a private tunnel. The platform stores only its URL — it can't reach in.",
            },
        ],
    },
    contrast: {
        eyebrow: "The difference",
        heading: "Everyone else lets you edit the prompt.",
        sub: "The prompt is the one layer you can already change anywhere. intentic opens the rest: the image its tools are installed in, the systems it's allowed to reach, the skills and runbooks it loads every turn — each layer visible in the workspace and yours to change. You can't make the model smarter. You can make it better informed and better equipped.",
        prompt: {
            label: "A prompt",
            caption: "a system prompt and a few .md files",
            points: [
                "Describes your tools — none are installed.",
                "No reach into your codebase, data, or services.",
                "Starts from the same blank context every run.",
                "Hands you generic output you finish by hand.",
            ],
        },
        agent: {
            label: "The whole environment",
            caption: "a sandbox you can open and change",
            points: [
                "Its dev-tools and libraries are really installed.",
                "Wired to your repos, databases, and services.",
                "Curated context loads every single run.",
                "Does the job end to end, shows its work as diffs.",
            ],
        },
    },
    anatomy: {
        eyebrow: "Anatomy",
        heading: "Four layers you can open.",
        sub: "Specializing an agent isn't writing a longer prompt — it's building it an environment. These are its four layers, and every one is visible in the workspace and editable by you.",
        pillars: [
            {
                title: "Its own sandbox",
                body: "A full workspace in a container on hardware you control — one per agent, so a whole team never steps on itself. Not a chat window: a machine the agent actually works on.",
            },
            {
                title: "A curated environment",
                body: "The libraries and dev-tools the job needs, baked into the image and really installed — a database client, a headless browser, your language toolchain. The agent proposes the layer; it ships on your approval.",
            },
            {
                title: "Access to your systems",
                body: "GitHub, databases, Sentry, Stripe, SSH hosts, MCP servers, your own internal tools — added in a click. Credentials stay in the sandbox; the agent operates them from chat.",
            },
            {
                title: "Curated context",
                body: "Skills, runbooks, repos, and house style scoped to this one job, loaded every turn. Not a generic dump — the context that makes the output yours instead of the model's average.",
            },
        ],
    },
    sandbox: {
        eyebrow: "Inside a sandbox",
        heading: "One agent, one machine, its tools really installed.",
        sub: "A specialized agent isn't a chat window — it's a container on hardware you own. The toolchain the job needs is baked into the image and genuinely runnable, and the context that makes the work yours loads on every turn.",
        boundary: "your machine · reached from your browser over a private tunnel",
        agent: { name: "release-captain", role: "owns the weekly release" },
        layers: [
            { label: "Environment · installed", items: ["node 24", "pnpm", "docker", "psql"] },
            { label: "Context · loaded every turn", items: ["6 skills", "release runbook", "house style"] },
        ],
    },
    integrations: {
        eyebrow: "Connected",
        heading: "Wired into the systems you already run.",
        sub: "Add what the role actually touches as capabilities — code, data, chat, docs, servers — a click each. The credential is stored inside the sandbox and never shown back to you; the agent operates the service from chat.",
        hubLabel: "your sandbox",
        hubSub: "keys stay inside",
        nodes: [
            { name: "GitHub", category: "Code & issues", logo: "github" },
            { name: "PostgreSQL", category: "Data", logo: "postgresql" },
            { name: "Sentry", category: "Observability", logo: "sentry" },
            { name: "Discord", category: "Communication", logo: "discord" },
            { name: "Outline", category: "Knowledge base", logo: "outline" },
            { name: "SSH hosts", category: "Servers", logo: "ssh" },
            { name: "Stripe", category: "Payments", logo: "stripe" },
            { name: "MCP", category: "Any tool", logo: "mcp" },
        ],
        note: "…plus any MCP server, Claude Code plugin, or self-hosted service — the catalog is open-ended, not a fixed list.",
    },
    workforce: {
        eyebrow: "Workforce",
        heading: "One agent, or a team that works while you don't.",
        sub: "Once an agent is specialized, it's cheap to run more. Give each role its own sandbox, wake them on the events that matter, and let them hand work down the line.",
        moments: [
            {
                title: "One sandbox per role",
                body: "A migrations agent, a release captain, a support triager — each with the environment, access, and context its job needs. Pro runs as many sandboxes as you have roles.",
            },
            {
                title: "Woken by events",
                body: "A push, a Sentry alert, a Stripe payment, an inbound email, or a schedule starts a fresh specialized run and leaves a transcript. They keep working between your check-ins.",
            },
            {
                title: "Chained into a graph",
                body: "One agent's run can fire the webhook that wakes the next — triage hands to fix, fix hands to review — so work moves through specialized hands instead of one generalist's.",
            },
        ],
    },
    teammate: {
        eyebrow: "In your tools",
        heading: "Talk to it like a teammate, where your team already works.",
        sub: "A specialized agent doesn't only answer behind a chat window here. Invite it into Discord and it reads and sends messages like any colleague — you assign the work, it does it, and it reports back with the receipts.",
        surface: "#releases",
        thread: [
            { author: "Dana", time: "9:41", text: "@release-captain ship 2.4 once CI is green, and drop the changelog in #announcements 🙏" },
            {
                author: "release-captain",
                agent: true,
                time: "9:41",
                text: "On it. Watching the pipeline — I'll tag the release, draft the changelog from the merged PRs, and post it the second it's green.",
            },
            {
                author: "release-captain",
                agent: true,
                time: "9:58",
                text: "✓ Tagged v2.4.0 · changelog posted in #announcements · deploy is live. 3 PRs shipped, no failures.",
            },
            { author: "Dana", time: "9:59", text: "🎉 thanks!" },
        ],
        note: "Reachable today in Discord and through an embeddable web-chat widget for your own site — the agent reads and sends messages itself, every credential staying inside its sandbox.",
    },
    ownership: {
        eyebrow: "Ownership",
        heading: "Real access is only safe if you own where it runs.",
        sub: "A specialized agent holds your keys and touches your systems — so it runs in a sandbox on hardware you control, reached by your browser over a private tunnel. The platform stores your identity and a URL, and can't reach in.",
        facts: [
            {
                title: "The workspace never leaves your machine",
                body: "Repos, credentials, and history live where the sandbox runs — a laptop, a workstation, a server. The platform never relays or stores your code.",
            },
            {
                title: "Keys stay in the sandbox",
                body: "Every capability's tokens are stored sandbox-side and denylisted from the file relay, so the agent uses them without them ever being shown or shipped out.",
            },
            {
                title: "The platform can't drive your agents",
                body: "Your browser holds the token that commands the sandbox — the platform never does. A breach reads a URL and reaches nothing. The sandbox is MIT on GitLab; verify it.",
            },
        ],
    },
    sharing: {
        eyebrow: "Shared, safely",
        heading: "Invite your team into the same specialized sandbox.",
        sub: "One agent, many people. The owner installs the tools and connects the systems; invited teammates share the very same sandbox — each reaching it from their own browser over their own private tunnel.",
        people: [
            { name: "You", role: "Owner", access: "installs tools · connects systems · full control", owner: true },
            { name: "Sam", role: "Teammate", access: "chats, drives & reviews · mirrors ports" },
            { name: "Ada", role: "Teammate", access: "chats, drives & reviews · mirrors ports" },
        ],
        sandboxLabel: "one specialized sandbox",
        sandboxSub: "release-captain · on the owner's machine",
        note: "Setup stays owner-gated and credentials never leave the box. Invite by email; sharing is a Pro feature — revoking or leaving never is.",
    },
    company: {
        eyebrow: "The whole picture",
        heading: "An entire company, assembled from specialized agents.",
        sub: "Zoom out and the pattern repeats: one co-piloted agent per role and per team, each in its own sandbox on hardware you own, connected to the handful of services they all share. A topology you assemble from the same primitives, not a template you click.",
        teams: ["Operations", "Governance", "Customer & Market", "Product Team A", "Product Team B", "Per-customer"],
        sharedServices: ["GitHub", "Discord", "Outline", "Infisical"],
        cta: "See the reference architecture",
    },
    economics: {
        eyebrow: "Economics",
        heading: "A whole team, on the subscriptions you already pay for.",
        sub: "A fleet of agents sounds expensive. It isn't. Each one runs on your own Claude, ChatGPT, or SuperGrok subscription — connected once with a sign-in code — on hardware you already own. intentic is a flat subscription, never a meter on your model usage.",
        accounts: [
            { name: "Claude", detail: "Opus, Sonnet, Haiku — on your Claude plan" },
            { name: "Codex", detail: "on your ChatGPT plan" },
            { name: "Grok", detail: "on your SuperGrok plan" },
            { name: "Kimi Code", detail: "on your Kimi Membership" },
            { name: "Gemini", detail: "on your Google account" },
        ],
        points: [
            "No per-token metering, and no markup on your model usage.",
            "No rented cloud compute — agents run where you run them.",
            "Free for one sandbox; Pro unlocks the fleet and sharing.",
        ],
    },
    connect: {
        eyebrow: "Get connected",
        heading: "One command, and an agent has a home.",
        sub: "Sign in, name the sandbox, paste one command on the machine that should host it. The workspace opens the moment the sandbox reports in — then you specialize the agent.",
        steps: [
            {
                title: "Sign in with Google",
                body: "No forms, no card. The platform stores your identity and the sandbox's URL — nothing else.",
            },
            {
                title: "Name the sandbox",
                body: "intentic prepares a private tunnel under its own domain — no Cloudflare account required. Bring your own zone if you'd rather.",
            },
            {
                title: "Paste one command",
                body: "A personalized one-liner starts the sandbox on your machine. Docker is installed if missing — you're asked first.",
            },
        ],
        commandNote: "Nothing deployed, nothing exposed — just a workspace your agent can call home.",
    },
    finalCta: {
        heading: "Stop editing prompts. Start editing environments.",
        sub: "One command to a live sandbox. Free to start, on your hardware.",
    },
};
