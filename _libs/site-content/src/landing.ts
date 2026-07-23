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

/** The hero visual: a specialized agent as a configured worker, not a chat window. */
export interface AgentSpec {
    name: string;
    role: string;
    rows: AgentSpecRow[];
    task: string;
    outcome: string;
}

/** One side of the "prompt vs specialized agent" comparison. */
export interface LandingContrastColumn {
    label: string;
    caption: string;
    points: string[];
}

export interface LandingContent {
    meta: { title: string; description: string };
    hero: {
        headlineLines: string[];
        subhead: string;
        chips: string[];
        spec: AgentSpec;
    };
    contrast: LandingSectionIntro & { prompt: LandingContrastColumn; agent: LandingContrastColumn };
    anatomy: LandingSectionIntro & { pillars: LandingFact[] };
    workforce: LandingSectionIntro & { moments: LandingFact[] };
    ownership: LandingSectionIntro & { facts: LandingFact[] };
    economics: LandingSectionIntro & { accounts: { name: string; detail: string }[]; points: string[] };
    connect: LandingSectionIntro & { steps: LandingFact[]; commandNote: string };
    finalCta: { heading: string; sub: string };
}

// One thesis, told once: a specialized agent is more than a prompt — it owns an environment (a
// sandbox, real dev-tools, access to your systems, curated context), which is why it beats a
// generic assistant, and why you can hand it real work and compose a team of them. Every claim maps
// to a shipping mechanism: environment overlays, capabilities/connectors, agent plugins/skills,
// sandboxes (Pro = many), and automations.
export const landingContent: LandingContent = {
    meta: {
        title: "intentic — Specialized agents that own their workspace",
        description:
            "A specialized agent is more than a prompt. intentic gives each coding agent its own sandbox — the libraries, dev-tools, and integrations its job needs, plus curated context — on hardware you own. Works with Claude Code, Codex, and Grok. Free to start.",
    },
    hero: {
        headlineLines: ["A specialized agent is", "more than a prompt."],
        subhead:
            "Give each agent its own sandbox — your libraries, your dev-tools, the systems you already run on, and the context only its job needs. Specialized agents beat generic ones. Run one, or a whole team, on hardware you own.",
        chips: ["Free plan", "Bring your own agent", "Runs on your hardware", "No inbound ports"],
        spec: {
            name: "release-captain",
            role: "Owns the weekly release",
            rows: [
                { label: "Environment", items: ["node 24", "pnpm", "docker", "psql"] },
                { label: "Connected", items: ["GitHub", "Sentry", "Discord", "prod db · read"] },
                { label: "Context", items: ["repo: platform", "6 skills", "release runbook", "house style"] },
            ],
            task: "Cut the 2.4 release and post the changelog.",
            outcome: "tag pushed · changelog drafted · deploy watched",
        },
    },
    contrast: {
        eyebrow: "Why specialized",
        heading: "A markdown file is not an agent.",
        sub: "The usual “custom agent” is a paragraph of instructions bolted onto a generic assistant. It can describe your stack; it can't run it. A specialized agent owns the whole environment the work happens in.",
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
            label: "A specialized agent",
            caption: "a sandbox of its own",
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
        heading: "Four things a prompt can't give it.",
        sub: "Specializing an agent isn't writing a longer prompt — it's giving it an environment. The same four things you'd give a new hire on day one.",
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
                body: "Your browser holds the token that commands the sandbox — the platform never does. A breach reads a URL and reaches nothing. The engine is MIT on GitLab; verify it.",
            },
        ],
    },
    economics: {
        eyebrow: "Economics",
        heading: "A whole team, on the subscriptions you already pay for.",
        sub: "A fleet of agents sounds expensive. It isn't. Each one runs on your own Claude, ChatGPT, or xAI subscription — connected once with a sign-in code — on hardware you already own. intentic is a flat subscription, never a meter on your model usage.",
        accounts: [
            { name: "Claude", detail: "Opus, Sonnet, Haiku — on your Claude plan" },
            { name: "Codex", detail: "on your ChatGPT plan" },
            { name: "Grok", detail: "on your xAI plan" },
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
        commandNote: "No open inbound ports, nothing deployed — just a workspace your agent can call home.",
    },
    finalCta: {
        heading: "Stop writing prompts. Start building agents.",
        sub: "One command to a live sandbox. Free to start, on your hardware.",
    },
};
