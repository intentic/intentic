import type { ProviderBrand } from "@intentic/constants";

import { productHref } from "./product";

export interface LandingFact {
    title: string;
    body: string;
}

export interface LandingSectionIntro {
    eyebrow: string;
    heading: string;
    sub: string;
}

/**
 * Name of a screenshot captured by `_tools/e2e/shots/capture.mts` (e.g. `fleet-board` -> its asset path). Only `name`
 * and `alt` are authored; size, format and variants come from the build.
 */
export interface ShotImage {
    name: string;
    alt: string;
}

/** One screen inside one of the hero's two frames, with the address it was taken at for the frame's title bar. */
export interface HeroScreen extends ShotImage {
    /** The pill in the frame's title bar. Where in the app this shot was taken. */
    frameLabel: string;
}

// Two windows: the workspace behind, the chat popped out in front; `app` and `chat` cycle in the order listed, first
// item shown first. Frames crop to one window height rather than scaling to fit (see Landing.astro).
export interface HeroScreens {
    /** The workspace window, behind and larger. */
    app: HeroScreen[];
    /** The chat, in the window the product pops it out into, in front, smaller, overlapping. */
    chat: HeroScreen[];
}

// Still image, kept as the page's LCP since it ships almost no JavaScript; the press link opens the demo in its own
// full-viewport page.
export interface HeroDemo {
    /** On the frame itself; says where the press goes, since "Play" alone could mean a video. */
    playLabel: string;
    /** Under the link: what the visitor is about to get, and what it is not. */
    note: string;
}

/**
 * One verb in the tour, one per Features-menu page: a line plus a proof (`shot`, or `figure` for Automate, which has no
 * honest screen to capture). Every item is the same size; there is no lead or compact one.
 */
export interface VerbTourItem {
    verb: string;
    href: string;
    line: string;
    shot?: { name: string; alt: string; label: string };
    /** Switch, not content: picks the AutomateFigure.astro diagram over a screenshot; text lives in automate.ts. */
    figure?: "automate";
}

/**
 * Workspace surfaces vs. a chat box, as two columns of nouns rather than argument. `chat.missing` stays one sentence:
 * as a list it would make the chat card the taller of the two.
 */
export interface WorkspaceComparison {
    ours: { label: string; note: string; items: string[] };
    chat: { label: string; note: string; items: string[]; missing: string };
    footnote: string;
}

export interface LandingContent {
    meta: { title: string; description: string };
    hero: {
        headlineLines: string[];
        subhead: string;
        screens: HeroScreens;
        demo: HeroDemo;
    };
    // Same five verbs as the Features menu; no `sub` (showcase). Its old branch claim now closes `workspace`.
    verbs: Omit<LandingSectionIntro, "sub" | "heading"> & { heading?: string; items: VerbTourItem[]; cta: string };
    workspace: LandingSectionIntro & { comparison: WorkspaceComparison };
    economics: LandingSectionIntro & { accounts: { name: string; logo: ProviderBrand; detail: string }[]; points: string[] };
    // Cards live in about.ts, shared with /about/; counts come from git at build and must never render zero.
    trust: { eyebrow: string; cta: string };
    // `desktop` sits beside the command: no macOS build exists, so leading with it reads as a gap to Mac users.
    connect: LandingSectionIntro & {
        steps: LandingFact[];
        commandNote: string;
        // A link, not a fork: one command for the reader's own machine; unsure readers opt out via the link.
        commandChoice: { lead: string; cta: string };
        desktop: { lead: string; cta: string; note: string };
    };
}

// One claim shown once: agents keep running, resumable anywhere; verbs show it, bands answer objections.
export const landingContent: LandingContent = {
    meta: {
        // Title ≤60 chars, description ≤160 (search truncates past that); title spends its room on the filter word.
        title: "intentic · Open-source workspace for coding agents",
        description: "A workspace for coding agents. They keep running when you close the browser. Reopen anywhere and review every change. Free.",
    },
    hero: {
        // Split 2+1 so line two lands the promise; "Agents" not "They" gives the pronoun a written antecedent.
        headlineLines: ["You delegate. Agents work.", "You approve."],
        // Names the category; nothing else above the fold does. Visibility comes from the surfaces beside it, not text.
        subhead: "A workspace for coding agents.",
        screens: {
            app: [
                {
                    name: "hero-agents",
                    alt: "The intentic fleet board: an Attention lane holding a Front Desk question and an agent asking one of its own, an Active lane with an agent working on a Stripe checkout, and a Finished lane where a completed change offers Land now. Each card carries a plain-English title, the model behind it, and what it has cost.",
                    frameLabel: "acme-shop · /agents",
                },
                {
                    name: "hero-review",
                    alt: 'A finished change waiting for a yes: the agent\'s task written as a plain title, a "Ready to land" badge over an unpressed Land now button, and a short side-by-side diff of the file it changed.',
                    frameLabel: "acme-shop · /agents",
                },
            ],
            chat: [
                {
                    name: "hero-chat-agents",
                    alt: "The chat in its own window, on the Agents cut: one active conversation in the rail and, beside it, the plan the agent wrote for adding Stripe checkout, with Approve and No, keep planning under it.",
                    frameLabel: "Chat · Agents",
                },
                {
                    name: "hero-chat-personas",
                    alt: "The same chat window on the Personas cut: Maya from customer care, Owen from growth and Priya from operations in the rail, with Maya's overnight support sweep open beside them and the screenshot she took of the cleared inbox.",
                    frameLabel: "Chat · Personas",
                },
            ],
        },
        demo: {
            playLabel: "Open the live workspace",
            note: "The real app on a recorded workspace. Approve a plan, answer an agent, read a diff.",
        },
    },
    // Five verbs, one screenful each, order matches the Features menu; Automate draws a diagram, not a screenshot.
    verbs: {
        eyebrow: "What you do",
        // One eyebrow ("Why a workspace" style); no heading below, the verbs and screenshots carry it.
        items: [
            {
                verb: "Run",
                href: productHref("run"),
                line: "One board shows every agent you have running, and puts the one that needs you first.",
                shot: {
                    name: "stage-run",
                    alt: "The intentic workspace on the fleet board: an Attention lane holding a Front Desk question and an agent asking one of its own, an Active lane where a Stripe checkout agent is running two subagents, and a Finished lane where a completed change offers Land now. Every card carries its model, its branch, what it has cost and its diff stats. The chat docked beside the board holds the plan that agent wrote, with Approve under it.",
                    label: "acme-shop · /agents",
                },
            },
            {
                verb: "Connect",
                href: productHref("connect"),
                line: "Connect an agent to GitHub, Postgres, Stripe, Discord or any MCP server. Your keys stay on your machine.",
                shot: {
                    name: "stage-connect",
                    alt: "The capability catalogue, twenty of them grouped by Platform, Code & issues, Observability, Data, Communication, Business & docs, Servers and Extend: GitHub, Sentry, PostgreSQL, Discord, Docker, Stripe, Obsidian, Outline, SSH and a VPN among them, seven marked as connected, and a row at the foot for any MCP server of your own.",
                    label: "acme-shop · /capabilities",
                },
            },
            {
                verb: "Automate",
                href: productHref("automate"),
                // Two real jobs before the mechanism: the drawing beside this line is already abstract.
                line: "Start an agent on a failing pipeline, a new issue or a schedule. Every run opens on your board.",
                // Only stage with no screenshot: the diagram carries it. An event does not start an agent, your check
                // does.
                figure: "automate",
            },
            {
                verb: "Review",
                href: productHref("review"),
                line: "The agent writes a plan and waits for your yes. Finished work sits on its branch until you read the diff.",
                shot: {
                    name: "stage-review",
                    alt: "The workspace Changes tab: five uncommitted files grouped by repo with their line counts, and CheckoutPanel.tsx open beside them as a side-by-side diff: the removed lines in red on the left, the added ones in green on the right. The chat alongside holds the plan the change came from.",
                    label: "acme-shop · /workspace",
                },
            },
            {
                verb: "Host",
                href: productHref("host"),
                line: "Move the workspace to a server so it runs without your laptop, and invite your team into the same one.",
                shot: {
                    name: "stage-host",
                    alt: "The acme-shop sandbox's Access page: the owner, a field to invite a teammate by email with their role beside it, the browsers currently signed in and a control that signs every one of them out, and under Here now a collaborator, Grace Hopper, looking at the agents board. The list on the left is everything else the box holds: environment, secrets, agent account, extensions, personas and devices.",
                    label: "acme-shop · /sandbox/access",
                },
            },
        ],
        cta: "Every feature, in detail",
    },
    // Answers what the hero's "you approve" promise needs: a two-column comparison of what you approve with.
    workspace: {
        eyebrow: "Why a workspace",
        heading: "You cannot approve what you cannot read.",
        sub: "Agents write a lot of code, quickly. Checking it is the real work, so the tools for checking it are the product.",
        comparison: {
            ours: {
                label: "Here",
                note: "What you get to look at.",
                items: [
                    "The diff of every file, before any of it lands",
                    "The editor and the file tree, to look anywhere yourself",
                    "The same terminal the agent is typing into",
                    "The run as it happens, stoppable mid-thought",
                    "What every run cost, agent by agent",
                ],
            },
            // Two items and a short closing line: keep this card visibly shorter than `ours`.
            chat: {
                label: "In a chat box",
                note: "What you get instead.",
                items: ["A wall of text", "An assurance that it worked"],
                missing: "Nothing to open, and nothing to check.",
            },
            footnote: "Every agent works on its own branch, so nothing it writes touches the files you have open.",
        },
    },
    economics: {
        eyebrow: "What it costs",
        // "intentic" stays lowercase even at a sentence start, per messaging.md.
        heading: "intentic is free. Agents use AI plans you already pay for.",
        sub: "You bring the AI plans, your machine does the work, and there is nothing to pay us.",
        // `logo` is the provider's brand mark; paths live in @intentic/constants so this can't drift from the app.
        accounts: [
            { name: "Claude", logo: "claude", detail: "Opus, Sonnet and Haiku, on your Claude plan" },
            { name: "Codex", logo: "codex", detail: "on your ChatGPT plan" },
            { name: "Grok", logo: "grok", detail: "on your SuperGrok plan" },
            { name: "Kimi Code", logo: "kimi", detail: "on your Kimi Membership" },
            { name: "Google", logo: "gemini", detail: "Gemini, Claude and GPT-OSS, free on a Google sign-in" },
            // Named for the plan, not the account: a free Cursor sign-in still cannot run a turn without the paid tier.
            { name: "Cursor", logo: "cursor", detail: "Composer and the frontier models, on your Cursor Pro plan" },
            // These two rows connect by pasting a key, not signing in; the detail line says which, before clicking.
            { name: "Z.ai", logo: "zai", detail: "GLM, on your Coding Plan key" },
            { name: "Meta", logo: "meta", detail: "Muse Spark, on your Model API key" },
        ],
        points: [
            "We never meter your tokens or add a markup.",
            "No cloud compute to rent. Agents run on the machine you start them on.",
            "Everything is included. No tiers, no limits, no card.",
        ],
    },
    // Name, bio, links and cards live in about.ts, shared with /about/; only this band's framing is here.
    trust: {
        eyebrow: "About the creator",
        cta: "More about who builds this",
    },
    connect: {
        eyebrow: "Getting started",
        heading: "Three steps to your first agent.",
        sub: "Sign in, paste one command, and your workspace opens.",
        steps: [
            {
                title: "Sign in with Google",
                // Defines "sandbox" (not "container") in plain words: the product's only noun for the thing, first used
                // here.
                body: "No forms and no card. We keep your email address and your workspace's address, and nothing else.",
            },
            {
                title: "Your sandbox is waiting",
                body: "Your sandbox is the private room your agents live and work in. We spin one up and give it its own web address, no Cloudflare account needed.",
            },
            {
                title: "Paste one command",
                body: "One line starts it on your own machine. If Docker is missing, it offers to install that first.",
            },
        ],
        commandNote: "It sets up your workspace on your own computer. Nothing is deployed anywhere and no ports are opened.",
        // Framed as a comparison: "one of two" says the command is a choice to check, not one to abandon.
        commandChoice: { lead: "This is one of two machines it can run on.", cta: "Compare them" },
        desktop: {
            lead: "Rather not touch a terminal?",
            cta: "Get the app for Windows or Linux",
            // States what the app is: the same install with a window around it; Mac readers use the command above.
            note: "It runs the same command for you: Docker if the machine needs it, then the sandbox, then your workspace.",
        },
    },
};
