export type LandingVariantId = "a" | "b" | "c";

export interface LandingFact {
    title: string;
    body: string;
}

export interface LandingSectionIntro {
    eyebrow: string;
    heading: string;
    sub: string;
}

export interface LandingTreeEntry {
    name: string;
    nested?: boolean;
}

export interface LandingContent {
    id: LandingVariantId;
    /** Short label shown on the dev preview switcher to tell variants apart. */
    name: string;
    meta: { title: string; description: string };
    hero: {
        headlineLines: string[];
        subhead: string;
        chips: string[];
        mock: {
            workspaceName: string;
            tree: LandingTreeEntry[];
            userMessage: string;
            planSteps: string[];
            status: string;
        };
    };
    connect: LandingSectionIntro & { steps: LandingFact[]; commandNote: string };
    anywhere: LandingSectionIntro & { moments: LandingFact[] };
    ownership: LandingSectionIntro & { facts: LandingFact[] };
    control: LandingSectionIntro;
    more: LandingSectionIntro & { items: LandingFact[] };
    finalCta: { heading: string; sub: string };
}

// One use case, three angles. Every variant sells the same thing — the coding agent you already
// use, running on your own machine, driven from any browser — and differs only in which door it
// walks the reader through: the agent (a), ownership (b), or the moment of use (c).
export const landingVariants: Record<LandingVariantId, LandingContent> = {
    a: {
        id: "a",
        name: "Agent-led",
        meta: {
            title: "intentic — A real workspace for your coding agent",
            description:
                "Take the coding agent you already run out of the terminal: chat, files, diffs, and terminals in any browser, served from your own machine. Works with Claude Code, Codex, and whatever ships next. Free to start.",
        },
        hero: {
            headlineLines: ["Your coding agent.", "Out of the terminal."],
            subhead:
                "intentic gives the agent you already run — Claude Code, Codex, whichever comes next — a real workspace: chat, file tree, editor, diffs, and terminals, served from your own hardware to any screen you're near.",
            chips: ["Free plan", "Bring your own agent", "Your machine, your keys", "No open inbound ports"],
            mock: {
                workspaceName: "workspace / api",
                tree: [
                    { name: "src/" },
                    { name: "server.ts", nested: true },
                    { name: "middleware/", nested: true },
                    { name: "test/" },
                    { name: "rate-limit.test.ts", nested: true },
                ],
                userMessage: "Add rate limiting to the public API and cover it with tests.",
                planSteps: [
                    "1. Read the middleware stack in src/server",
                    "2. Add a token-bucket limiter with config",
                    "3. Test burst, refill, and per-key limits",
                ],
                status: "9 files changed · tests green · diff ready to review",
            },
        },
        connect: {
            eyebrow: "Get connected",
            heading: "One command to a live workspace.",
            sub: "Sign in, name your sandbox, paste one command into a terminal. The workspace opens the moment your sandbox reports in.",
            steps: [
                {
                    title: "Sign in with Google",
                    body: "No forms, no card. The platform stores your identity and your sandbox's URL — nothing else.",
                },
                {
                    title: "Name your sandbox",
                    body: "intentic prepares a private tunnel under its own domain — no Cloudflare account required.",
                },
                {
                    title: "Paste one command",
                    body: "A personalized one-liner starts the sandbox on your machine. Docker is installed if missing — you're asked first.",
                },
            ],
            commandNote: "No open inbound ports, nothing deployed — just your workspace, reachable.",
        },
        anywhere: {
            eyebrow: "Anywhere",
            heading: "One session, every screen.",
            sub: "The session lives on your machine, not in a browser tab. Close the laptop, open your phone — the same chat, files, and terminals are waiting.",
            moments: [
                {
                    title: "Start at your desk",
                    body: "Hand the agent real work in the browser — full file tree, editor, and terminals alongside the chat.",
                },
                {
                    title: "Check in from your phone",
                    body: "Plan mode means the agent proposes and waits. Approve, redirect, or stop it from wherever you are.",
                },
                {
                    title: "Come back to diffs",
                    body: "Everything it changed since you last looked, as diffs you commit or discard — never a mystery working tree.",
                },
            ],
        },
        ownership: {
            eyebrow: "Ownership",
            heading: "Your code never moves out.",
            sub: "The sandbox is a container on hardware you control — a laptop, a workstation, a VPS. Your browser reaches it directly over a private tunnel; the platform stores your identity and a URL, and can't reach anything else.",
            facts: [
                {
                    title: "Files stay on your machine",
                    body: "Repos, credentials, and history live where the sandbox runs. The platform never relays or stores your code.",
                },
                {
                    title: "Keys stay in the sandbox",
                    body: "Capability tokens and API keys are stored inside the sandbox; secret files are denylisted from the file relay.",
                },
                {
                    title: "The platform can't reach in",
                    body: "Your browser holds the token that drives the sandbox — the platform never does. A platform breach can't touch your machine.",
                },
            ],
        },
        control: {
            eyebrow: "Control",
            heading: "Autonomy with a steering wheel.",
            sub: "Plan mode by default: the agent proposes, you approve. Review every change as a diff — discard or commit. Environment changes ship only with your sign-off.",
        },
        more: {
            eyebrow: "Included",
            heading: "More than a chat window.",
            sub: "The workspace grows with the work — everything below is included in the free plan.",
            items: [
                {
                    title: "Capabilities",
                    body: "GitHub, databases, Sentry, Discord, Stripe, SSH, MCP servers — added in a click, operated from chat, credentials kept in the sandbox.",
                },
                {
                    title: "Automations",
                    body: "Wake the agent on a schedule, a webhook, or a live event — a push, an alert, a payment, an email. Each run leaves a transcript.",
                },
                {
                    title: "Deploys, when you're ready",
                    body: "The built-in open-source engine turns one config file into git, CI, and a deployment on your own server — a nice sidecar, not homework.",
                },
            ],
        },
        finalCta: {
            heading: "Give your agent a workspace.",
            sub: "One command from a live session. Free to start.",
        },
    },
    b: {
        id: "b",
        name: "Ownership-led",
        meta: {
            title: "intentic — The AI workspace you own",
            description:
                "Agent autonomy without shipping your code to a vendor's cloud. The sandbox runs on your machine; the platform stores your identity and a URL and can't reach anything else. Your coding agent, from any browser. Free to start.",
        },
        hero: {
            headlineLines: ["The AI workspace", "you own."],
            subhead:
                "Cloud agent platforms run your code on their machines. intentic runs the agent on yours — the same browser workspace, chat to terminals, with nothing to hand over.",
            chips: ["Free plan", "Runs on your hardware", "Platform can't read your code", "Open-source MIT engine"],
            mock: {
                workspaceName: "workspace / platform",
                tree: [
                    { name: "src/" },
                    { name: "config.ts", nested: true },
                    { name: "ci/" },
                    { name: "deploy.yml", nested: true },
                    { name: "reports/" },
                    { name: "audit.md", nested: true },
                ],
                userMessage: "Rotate the staging credentials and audit everywhere they were used.",
                planSteps: [
                    "1. Find every use across configs and CI",
                    "2. Rotate the keys via the provider CLI",
                    "3. Write the exposure report to audit.md",
                ],
                status: "keys rotated · audit.md written · nothing left this machine",
            },
        },
        connect: {
            eyebrow: "Get connected",
            heading: "Your hardware, minutes to live.",
            sub: "Sign in, name your sandbox, paste one command on whichever machine should hold your code — a laptop, a workstation, a VPS.",
            steps: [
                {
                    title: "Sign in with Google",
                    body: "An identity, nothing more. No card, no code upload, no repo permissions.",
                },
                {
                    title: "Name your sandbox",
                    body: "A private tunnel is prepared under intentic's domain — or bring your own Cloudflare zone; your token is used once and never stored.",
                },
                {
                    title: "Paste one command",
                    body: "The sandbox starts where you run it. Docker is installed if missing — you're asked first.",
                },
            ],
            commandNote: "No open inbound ports, nothing deployed — the machine is yours to pick, and the code never has to leave it.",
        },
        anywhere: {
            eyebrow: "The workspace",
            heading: "The cloud UX, without the custody.",
            sub: "You keep the part cloud platforms got right — a workspace in any browser, sessions that survive the tab — served from your machine instead of theirs.",
            moments: [
                {
                    title: "Any browser",
                    body: "Chat, file tree, editor, diffs, and terminals — from your desk, your laptop, your phone.",
                },
                {
                    title: "Direct connection",
                    body: "The browser talks to your sandbox over a private tunnel. Your files and prompts never route through intentic's servers.",
                },
                {
                    title: "Sessions persist",
                    body: "Terminals and agent runs live on your machine and survive reconnects — pick up exactly where you left off.",
                },
            ],
        },
        ownership: {
            eyebrow: "Ownership",
            heading: "Built to be unable to betray you.",
            sub: "This is architecture, not policy: the platform stores your identity and your sandbox's URL. It never holds the token your browser signs in with — so it cannot drive your sandbox, even breached.",
            facts: [
                {
                    title: "Your code never leaves your machine",
                    body: "Repos, files, and history live where the sandbox runs. The platform never relays or stores them.",
                },
                {
                    title: "Credentials stay inside your sandbox",
                    body: "Capability tokens live in the sandbox; secret files are denylisted from the file relay. The little the platform stores is AES-256-GCM encrypted.",
                },
                {
                    title: "Read the code that claims this",
                    body: "The engine is MIT on GitHub, tests included. Verify the architecture instead of trusting the pitch.",
                },
            ],
        },
        control: {
            eyebrow: "Control",
            heading: "You approve every consequential step.",
            sub: "Plan mode by default: the agent proposes, you approve. Every file change is a diff you commit or discard; environment changes ship only with your sign-off.",
        },
        more: {
            eyebrow: "Included",
            heading: "Grows without giving anything up.",
            sub: "Everything you add stays under the same rule: it runs on your machine, and its credentials never leave the sandbox.",
            items: [
                {
                    title: "Capabilities",
                    body: "GitHub, databases, Sentry, Discord, Stripe, SSH, MCP servers — added in a click, secrets stored sandbox-side only.",
                },
                {
                    title: "Automations",
                    body: "Wake the agent on a schedule, a webhook, or a live event. It works on your hardware even while you're away.",
                },
                {
                    title: "Self-hosted deploys",
                    body: "The open-source engine deploys your apps to your own server — git, CI, registry, and DNS derived from one config.",
                },
            ],
        },
        finalCta: {
            heading: "Own the workspace, not just the repo.",
            sub: "One command, on your hardware. Free to start.",
        },
    },
    c: {
        id: "c",
        name: "Moment-led",
        meta: {
            title: "intentic — Your coding agent, from anywhere",
            description:
                "Give the agent real work at your desk, approve its plan from your phone, come back to reviewed diffs. Your coding agent, running on your own machine, in any browser. Free to start.",
        },
        hero: {
            headlineLines: ["Start at your desk.", "Approve from your phone."],
            subhead:
                "Your coding agent shouldn't stop when you stand up. intentic runs it on your machine and hands you the live session in any browser — the work continues; only your screen changes.",
            chips: ["Free plan", "Sessions survive the tab", "One session, every device", "Your machine, your keys"],
            mock: {
                workspaceName: "workspace / web",
                tree: [
                    { name: "src/" },
                    { name: "app.css", nested: true },
                    { name: "components/", nested: true },
                    { name: "pages/", nested: true },
                    { name: "package.json" },
                ],
                userMessage: "Migrate the app to Tailwind 4 — flag anything that changes visually.",
                planSteps: [
                    "1. Upgrade the deps and the Vite plugin",
                    "2. Move the config to CSS-first",
                    "3. Screenshot-diff every page, list changes",
                ],
                status: "approved from your phone · 23 files changed · 2 visual changes flagged",
            },
        },
        connect: {
            eyebrow: "Get connected",
            heading: "From sign-in to a live session.",
            sub: "Three steps, one of them a paste. Your workspace opens on its own the moment the sandbox reports in.",
            steps: [
                {
                    title: "Sign in with Google",
                    body: "No forms, no card. The platform stores your identity and your sandbox's URL — nothing else.",
                },
                {
                    title: "Name your sandbox",
                    body: "intentic prepares a private tunnel under its own domain — no Cloudflare account required.",
                },
                {
                    title: "Paste one command",
                    body: "One-liner in a terminal, Docker installed if missing (you're asked first), and the session is live.",
                },
            ],
            commandNote: "Run it on the machine that should do the work — your laptop, a desktop that stays on, a VPS.",
        },
        anywhere: {
            eyebrow: "A day with it",
            heading: "A workday with the agent.",
            sub: "The session is one URL. What you do with it depends on where you are.",
            moments: [
                {
                    title: "09:00 — at your desk",
                    body: "Full workspace: chat beside the file tree, editor, and terminals. Hand over the task, shape the plan.",
                },
                {
                    title: "12:40 — in line for lunch",
                    body: "The agent finished and proposed the next step. Approve it from your phone; it gets back to work.",
                },
                {
                    title: "17:00 — back at your desk",
                    body: "Read the diff of everything that happened, commit what's right, discard what isn't.",
                },
            ],
        },
        ownership: {
            eyebrow: "Ownership",
            heading: "Anywhere, because it's yours.",
            sub: "The session travels because your browser connects to your machine — not because your code moved to someone's cloud. The platform stores your identity and a URL; everything else stays home.",
            facts: [
                {
                    title: "Home is your machine",
                    body: "The sandbox runs where you started it. Repos, credentials, and history never leave it.",
                },
                {
                    title: "Secrets don't travel",
                    body: "Capability tokens live in the sandbox; secret files are denylisted from the file relay.",
                },
                {
                    title: "No vendor in the loop",
                    body: "Browser → tunnel → sandbox. The platform is off the command path and can't reach your daemon.",
                },
            ],
        },
        control: {
            eyebrow: "Control",
            heading: "It waits for you — not the reverse.",
            sub: "Plan mode by default: proposals wait for your approval wherever you are. Every change is a diff you commit or discard; environment changes need your explicit sign-off.",
        },
        more: {
            eyebrow: "Included",
            heading: "When one task becomes a system.",
            sub: "The same session picks up more reach as you need it — all of it included in the free plan.",
            items: [
                {
                    title: "Capabilities",
                    body: "GitHub, databases, Sentry, Discord, Stripe, SSH, MCP servers — added in a click, operated from chat.",
                },
                {
                    title: "Automations",
                    body: "Why wake it by hand? Schedules, webhooks, and live events keep the agent working between your check-ins.",
                },
                {
                    title: "Deploys",
                    body: "When something's ready to ship, the built-in open-source engine deploys it to your own server from one config file.",
                },
            ],
        },
        finalCta: {
            heading: "Your next session is one command away.",
            sub: "Works with the agent you already use. Free to start.",
        },
    },
};

export function resolveLandingVariant(value: string | undefined): LandingContent {
    if (value && value in landingVariants) return landingVariants[value as LandingVariantId];
    return landingVariants.a;
}
