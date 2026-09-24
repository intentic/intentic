import type { ProviderBrand } from "@intentic/constants";

import { productHref } from "./product";
import { DEMO_PATH, DESK_PATH } from "./site";

export interface LandingFact {
    title: string;
    body: string;
}

export interface LandingSectionIntro {
    eyebrow: string;
    heading: string;
    sub: string;
}

/** Name of a screenshot captured by `_tools/e2e/shots/capture.mts`. */
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

/** One row in the tour, one per Features-menu page: a line plus a proof (`shot`, or `figure` for Automations, which has no honest screen to capture). */
export interface VerbTourItem {
    label: string;
    href: string;
    line: string;
    shot?: { name: string; alt: string; label: string };
    /** Switch, not content: picks the AutomateFigure.astro diagram over a screenshot; text lives in automate.ts. */
    figure?: "automate";
}

/** Workspace surfaces vs. */
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
    // Same five rows as the Features menu; no `sub` (showcase). Its old branch claim now closes `workspace`.
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
    /** The other product, named under the hero: the one line a reader in the wrong place needs. */
    crossLink: CrossLink;
}

export interface CrossLink {
    lead: string;
    label: string;
    href: string;
}

// One claim shown once: agents keep running, resumable anywhere; the tour shows it, bands answer objections.
export const landingContent: LandingContent = {
    meta: {
        // Title ≤60 chars, description ≤160 (search truncates past that); title spends its room on the filter word.
        title: "intentic · Open-source workspace for coding agents",
        description: "A workspace for coding agents. They keep running when you close the browser. Reopen anywhere and review every change. Free.",
    },
    hero: {
        // Split 2+1 so line two lands the promise; three beats, last one alone.
        headlineLines: ["More work. Less AI waste.", "Same subscriptions."],
        // Names the category; nothing else above the fold does. Visibility comes from the surfaces beside it, not text.
        subhead: "A workspace for coding agents.",
        screens: {
            app: [
                {
                    name: "hero-agents",
                    alt: "The intentic fleet board: an Attention lane holding a Visitor chat question and an agent asking one of its own, an Active lane with an agent working on a Stripe checkout, and a Finished lane where a completed change offers Land now. Each card carries a plain-English title, the model behind it, and what it has cost.",
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
    // Five rows, one screenful each, order matches the Features menu; Automations draws a diagram, not a screenshot.
    verbs: {
        eyebrow: "What you do",
        // One eyebrow ("Why a workspace" style); no heading below, the verbs and screenshots carry it.
        items: [
            {
                label: "Agent Workspace",
                href: productHref("run"),
                line: "One board shows every agent you have running, and puts the one that needs you first.",
                shot: {
                    name: "stage-run",
                    alt: "The intentic workspace on the fleet board: an Attention lane holding a Visitor chat question and an agent asking one of its own, an Active lane where a Stripe checkout agent is running two subagents, and a Finished lane where a completed change offers Land now. Every card carries its model, its branch, what it has cost and its diff stats. The chat docked beside the board holds the plan that agent wrote, with Approve under it.",
                    label: "acme-shop · /agents",
                },
            },
            {
                label: "Integrations",
                href: productHref("connect"),
                line: "Connect an agent to GitHub, Postgres, Stripe, Discord or any MCP server. Your keys stay on your machine.",
                shot: {
                    name: "stage-connect",
                    alt: "The capability catalogue, twenty of them grouped by Platform, Code & issues, Observability, Data, Communication, Business & docs, Servers and Extend: GitHub, Sentry, PostgreSQL, Discord, Docker, Stripe, Obsidian, Outline, SSH and a VPN among them, seven marked as connected, and a row at the foot for any MCP server of your own.",
                    label: "acme-shop · /capabilities",
                },
            },
            {
                label: "Automations",
                href: productHref("automate"),
                // Two real jobs before the mechanism: the drawing beside this line is already abstract.
                line: "Start an agent on a failing pipeline, a new issue or a schedule. Every run opens on your board.",
                // Only stage with no screenshot: the diagram carries it. An event does not start an agent, your check
                // does.
                figure: "automate",
            },
            {
                label: "Approvals",
                href: productHref("review"),
                line: "The agent writes a plan and waits for your yes. Finished work sits on its branch until you read the diff.",
                shot: {
                    name: "stage-review",
                    alt: "The workspace Changes tab: five uncommitted files grouped by repo with their line counts, and CheckoutPanel.tsx open beside them as a side-by-side diff: the removed lines in red on the left, the added ones in green on the right. The chat alongside holds the plan the change came from.",
                    label: "acme-shop · /workspace",
                },
            },
            {
                label: "Self-hosting",
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
    crossLink: { lead: "Not a programmer?", label: "intentic desk, the same assistant for your documents", href: DESK_PATH },
};

/** A picture in the light set: a shot of the desk recording (`capture.mts --desk`), or a default shot's light twin. */
export interface DeskShot {
    name: string;
    alt: string;
}

/** One row of the desk page's tour. Links to the shared feature page; a row with no shot draws the Automations figure. */
export interface DeskTourItem {
    label: string;
    href: string;
    line: string;
    shot?: DeskShot & { label: string };
    figure?: "automate";
}

export interface DeskFaqItem {
    /** Anchor id, its own namespace so it can never collide with the developer page's questions. */
    id: string;
    question: string;
    answer: string[];
    more?: { label: string; href: string };
}

// INTENTIC DESK: the same assistant sold to the reader who does not write code, as a product page of its own at
// /desk/ (site pages/desk.astro, DeskLanding.astro). Its own words from the first line to the last question, its
// own pictures (the desk recording, _site/demo/src/fixture/desk.ts), its own title and description, its own place in
// the sitemap. What it shares with the developer page is the shell and the parts that are true of both products —
// the nav and footer, the cost band's account list, the trust band — never a paragraph of copy, so search never
// meets the same page twice under two addresses. Nothing here names git, a repository or a terminal.
export interface DeskLandingContent {
    meta: { title: string; description: string };
    hero: {
        headlineLines: string[];
        subhead: string;
        screens: { app: (DeskShot & { frameLabel: string })[]; plan: DeskShot; chat: DeskShot & { frameLabel: string } };
        /** Where the frame's press goes: the desk recording, not the code one. */
        demoHref: string;
        /** The two doors: browser first for this reader; download stays for Windows and Linux. */
        actions: { download: string; browser: string };
    };
    tour: { eyebrow: string; items: DeskTourItem[]; cta: string };
    workspace: LandingSectionIntro & { comparison: WorkspaceComparison; cta: { label: string; href: string } };
    /** The account list is shared with the developer page (landingContent.economics.accounts): the plans are the same plans. */
    economics: LandingSectionIntro & { flatLabel: string; points: string[] };
    // Browser first: for this reader the app is the way in, and the install is optional.
    connect: LandingSectionIntro & {
        zones: { computer: string; app: string };
        computerStep: LandingFact;
        appSteps: LandingFact[];
        browser: { lead: string; note: string; cta: string };
    };
    faq: { eyebrow: string; heading: string; lede: string; items: DeskFaqItem[] };
    crossLink: CrossLink;
}

export const deskLanding: DeskLandingContent = {
    meta: {
        title: "intentic desk · An assistant for your documents",
        description:
            "An assistant that writes, edits and files your documents on your own computer. Every change is saved, so you can always go back. Free.",
    },
    hero: {
        headlineLines: ["More work. Less AI waste.", "Same subscriptions."],
        subhead: "An assistant for your documents, on your own computer.",
        screens: {
            app: [
                {
                    name: "desk-hero-agents",
                    alt: "The intentic board on a desk of documents: an Attention lane holding an assistant waiting on a question about a supplier letter, an Active lane where one is rewriting the October newsletter, and a Finished lane with a draft of the September newsletter to read and a receipts sort already accepted.",
                    frameLabel: "my-desk · Assistants",
                },
                {
                    name: "desk-hero-files",
                    alt: "The desk's files with the newsletter folder open: August's, September's and October's drafts, the template, the subscriber list and a folder of pictures, drawn as documents rather than as a code tree.",
                    frameLabel: "my-desk · Files",
                },
            ],
            plan: {
                name: "desk-hero-plan",
                alt: "The chat beside the desk, holding the plan the assistant wrote for rewriting the October newsletter around the sale, with Approve and No, keep planning under it.",
            },
            chat: {
                name: "desk-hero-chat",
                alt: "The chat in its own window: the plan the assistant wrote for rewriting the October newsletter around the sale, with Approve and No, keep planning under it.",
                frameLabel: "Chat · Newsletter",
            },
        },
        demoHref: `${DEMO_PATH}agents?mode=desk`,
        actions: { download: "Download the app", browser: "Use it in the browser" },
    },
    tour: {
        eyebrow: "What you do",
        items: [
            {
                label: "Your assistant",
                href: productHref("run"),
                line: "One board shows everything you have asked for, and puts the one that needs you first.",
                shot: {
                    name: "desk-stage-run",
                    alt: "The intentic workspace on the board: one assistant rewriting the October newsletter, one waiting on a question about a letter to the supplier, a finished draft of the September newsletter, and the docked chat holding the plan with Approve under it.",
                    label: "my-desk · Assistants",
                },
            },
            {
                label: "Connections",
                href: productHref("connect"),
                line: "Give it your mail, your calendar, your files or your shop. Your passwords stay on your computer.",
                shot: {
                    name: "stage-connect",
                    alt: "The connections catalogue, grouped by what each one is for: GitHub, a database, Discord, Stripe, Obsidian, Outline and a server among them, seven already connected, and a row at the foot for anything of your own.",
                    label: "my-desk · Connections",
                },
            },
            {
                label: "On a schedule",
                href: productHref("automate"),
                line: "Have it read your inbox every morning, or answer a message the moment one arrives. Every run shows up on your board.",
                figure: "automate",
            },
            {
                label: "Your say",
                href: productHref("review"),
                line: "It writes a plan first and waits for your yes. Every change is saved as a version, so you can always go back.",
                shot: {
                    name: "desk-stage-review",
                    alt: "A finished draft, read as what changed: the September newsletter moved into the new template, with the assistant's own account of the work beside it.",
                    label: "my-desk · What changed",
                },
            },
            {
                label: "Anywhere",
                href: productHref("host"),
                line: "Keep it on your computer, or move it to a server so it works while your laptop is closed.",
                shot: {
                    name: "stage-host",
                    alt: "The workspace's Access page: the owner, a field to invite someone by email, the browsers currently signed in, and under Here now a collaborator looking at the board.",
                    label: "my-desk · Access",
                },
            },
        ],
        cta: "Every feature, in detail",
    },
    workspace: {
        eyebrow: "Why a workspace",
        heading: "You can see exactly what it changed.",
        sub: "An assistant that edits your files has to show you what it did. Here, every change is on screen before you accept it.",
        comparison: {
            ours: {
                label: "Here",
                note: "What you get to look at.",
                items: [
                    "What changed in every document, before you accept it",
                    "Your files, in folders you can open any time",
                    "The work as it happens, stoppable at any moment",
                    "A saved version of every accepted change, to go back to",
                    "What every task cost",
                ],
            },
            chat: {
                label: "In a chat box",
                note: "What you get instead.",
                items: ["A wall of text", "An assurance that it worked"],
                missing: "Nothing to open, and nothing to check.",
            },
            footnote: "Every task works on its own copy, so nothing touches the file you have open until you say so.",
        },
        cta: { label: "How accepting a change works", href: productHref("review") },
    },
    economics: {
        eyebrow: "What it costs",
        heading: "intentic is free. It uses the AI plan you already pay for.",
        sub: "Bring your Claude, ChatGPT or Google account. Your computer does the work, and there is nothing to pay us.",
        flatLabel: "Flat, not metered",
        points: [
            "We never meter what it uses or add a markup.",
            "Nothing to rent. The assistant runs on the computer you start it on.",
            "Everything is included. No tiers, no limits, no card.",
        ],
    },
    connect: {
        eyebrow: "Getting started",
        heading: "Three steps to your first task.",
        sub: "Download the app, sign in, and ask for something.",
        zones: { computer: "on your computer", app: "in the app" },
        computerStep: {
            title: "Download the app",
            body: "Windows and Linux. It installs what it needs, asks before it does, and opens your workspace when it is done.",
        },
        appSteps: [
            {
                title: "Sign in with Google",
                body: "No forms and no card. We keep your email address and your workspace's address, and nothing else.",
            },
            {
                title: "Ask for something",
                body: "Type what you want done, in your own words. The plan comes back first, and nothing changes until you say yes.",
            },
        ],
        browser: {
            lead: "Rather not install anything?",
            note: "Sign in from your browser and it walks you through the same setup, one command included.",
            cta: "Use it in the browser",
        },
    },
    faq: {
        eyebrow: "FAQ",
        heading: "Before you install it.",
        lede: "What it costs, where your files stay, and what is not built yet.",
        items: [
            {
                id: "desk-what-do-i-need",
                question: "What do I need to run it?",
                answer: [
                    "A Windows or Linux computer and a Google account to sign in with. The app installs everything else it needs, and asks before it does.",
                    "It works with the AI plan you already have: Claude, ChatGPT, or a free Google sign-in.",
                ],
                more: { label: "Download the app", href: "/download/" },
            },
            {
                id: "desk-where-are-my-files",
                question: "Where do my files live?",
                answer: [
                    "On your own computer, in an ordinary folder you can open with anything else. Nothing is uploaded to us.",
                    "The assistant works on a copy of its own, and nothing touches your file until you accept the change. Every accepted change is saved as a version, so you can always go back.",
                ],
            },
            {
                id: "desk-what-does-it-cost",
                question: "What does it cost?",
                answer: [
                    "Nothing. intentic is free and open source. The assistant runs on the AI plan you bring, and we never meter or mark up what it uses.",
                ],
            },
            {
                id: "desk-can-it-read-my-mail",
                question: "Can it read my mail or my calendar?",
                answer: [
                    "Only if you connect them, and you can disconnect them at any time. Your passwords stay on your computer; the assistant is handed what it needs for one task at a time, and every connection is listed where you can see it.",
                ],
                more: { label: "What it can connect to", href: productHref("connect") },
            },
            {
                id: "desk-do-i-need-to-learn-anything",
                question: "Do I need to learn anything technical?",
                answer: [
                    "No. You type what you want in your own words, read the plan it writes back, and say yes or no. The words on screen are plain ones: a draft, a version, what changed.",
                    "If you do write code, the same product has a developer edition, with the file tree and every panel.",
                ],
                more: { label: "The developer edition", href: "/?variant=default" },
            },
            {
                id: "desk-is-there-a-mac-version",
                question: "Is there a Mac version?",
                answer: [
                    "Not yet. On a Mac, use it in the browser: sign in at app.intentic.dev and it walks you through the setup, one command included.",
                ],
            },
        ],
    },
    crossLink: { lead: "Write code?", label: "The developer edition of intentic", href: "/?variant=default" },
};
