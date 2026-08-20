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
 * A screenshot, named by the shot `_tools/e2e/shots/capture.mts` wrote: `fleet-board` is
 * `_site/site/src/assets/product/fleet-board.png`. Only the name and the alt text are content: the file's
 * pixel size, format and variants belong to the build, which reads them off the file itself.
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

/* THE HERO VISUAL: two windows, because that is what this product looks like in use — the workspace in one,
 * and the chat lifted out of it into another (the app's own pop-out). One still frame of a fleet board could
 * only ever make one of the page's claims; a workspace beside a live conversation makes the whole of it.
 *
 * EACH FRAME CYCLES, in the order written here, and the two lists are DIFFERENT LENGTHS on purpose: three
 * surfaces behind, two conversations in front, so the pair never settles into one repeating picture. Order is
 * editorial and the first of each is the one a stranger sees first — so `app` opens on the board, which is the
 * page's subject, and `chat` opens on the agents cut, which is the conversation the board's cards lead to.
 *
 * The frames CROP their screens rather than fitting them (see Landing.astro): every capture is one window
 * height and the surfaces inside are wildly different lengths, so what a reader sees is the top of each. */
export interface HeroScreens {
    /** The workspace window, behind and larger. */
    app: HeroScreen[];
    /** The chat, in the window the product pops it out into — in front, smaller, overlapping. */
    chat: HeroScreen[];
}

/* The invitation to stop looking at the screenshot and use the thing. The hero keeps the still image because it
 * is the LCP and this page ships almost no JavaScript. The press links to the demo's own page, where an IDE
 * gets the whole viewport instead of a hole cut in a marketing page. */
export interface HeroDemo {
    /** On the frame itself. Says where the press goes, because "Play" on a screenshot could mean a video. */
    playLabel: string;
    /** Under the link: what the visitor is about to get, and what it is not. */
    note: string;
}

/**
 * One verb in the tour: the home page's single telling of what the product does. Each maps 1:1 to a page
 * in the Features menu and carries ONE line plus one proof: a real browser screenshot (`shot`, named like a
 * `ShotImage` and framed with the route it was taken on) OR, for Automate, the list of events it wakes on.
 * because there is no honest screenshot of an automations screen and a mockup would be the one lie here.
 * The first item leads the section at full width; the rest are compact cards.
 */
export interface VerbTourItem {
    verb: string;
    href: string;
    line: string;
    shot?: { name: string; alt: string; label: string };
    triggers?: string[];
}

/**
 * Why this is a workspace and not a chat box: the surfaces that let you check the work, against what a
 * chat box gives you instead. Two columns of nouns rather than three paragraphs of argument, because the
 * claim is a comparison.
 *
 * `chat.missing` is one sentence rather than a list on purpose. As three more rows it made the thin card
 * the taller of the two, which is the exact opposite of the point the band is making.
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
        /** The plain, literal restatement under the subhead. Named concepts, not persuasion. */
        summary: string;
        chips: string[];
        screens: HeroScreens;
        demo: HeroDemo;
    };
    /* The one telling of what you do with the product, in the same five verbs as the Features menu. So the
     * home page and the feature pages read as one product. It replaces the old "loop" beats and "extend"
     * bento, which between them said the same powers three times over. */
    verbs: LandingSectionIntro & { items: VerbTourItem[]; cta: string };
    workspace: LandingSectionIntro & { comparison: WorkspaceComparison };
    economics: LandingSectionIntro & { accounts: { name: string; logo: ProviderBrand; detail: string }[]; points: string[] };
    /* Who is behind the promises the page just made. It sits here, last before `#connect`, because the
     * conversion order is claim → proof → objection → action: its first card answers the architectural
     * half of "can I trust this" (it is the only place on the page that does, now that the ownership
     * band is retired), and the human half is the objection still standing when `#connect` says
     * "paste this command on your machine".
     *
     * The cards come from `about.ts`, shared with /about/, and the commit numbers are measured from git
     * at build time: never authored. The band has no slot that can render a zero: an empty social-proof
     * counter is the one thing here that would cost more trust than it buys. */
    trust: { eyebrow: string; cta: string };
    /* Step 3 is "paste this in a terminal", and that is the likeliest place on this page to lose somebody who
     * has read all of it: not because the command does more than an installer would, but because it arrives
     * with none of an installer's affordances. `desktop` is the way out, and it sits BESIDE the command rather
     * than above it: there is no macOS build, so a download offered first reads as a gap to a third of the
     * audience, while the same download offered next to a one-liner that works everywhere reads as the
     * shortcut it is. It stays secondary for the same reason the hero has one button: the app is a window
     * around this install, not a second product to choose between. */
    connect: LandingSectionIntro & {
        steps: LandingFact[];
        commandNote: string;
        desktop: { lead: string; cta: string; note: string };
    };
    finalCta: { heading: string; sub: string };
}

// One claim, proven once: your agents run on hardware you own, keep running when you look away, and
// any browser, including a phone, reopens onto the same fleet, with nothing reaching your tree until you
// have read the diff. The hero states it; the five verbs show it; `#workspace` shows what you read it
// WITH; the bands below answer the objections it raises (what it costs, who builds it) and then hand
// you the one command to start.
export const landingContent: LandingContent = {
    meta: {
        // Under 160 characters: a search result truncates past that, and this one has to survive
        // the cut with the claim and the price still in it.
        title: "intentic · A workspace for coding agents",
        description:
            "A workspace for coding agents on hardware you own. They keep running when you close the browser. Reopen anywhere and review every change. Free.",
    },
    hero: {
        // Three beats, split 2 + 1 so the second line lands the one the reader has to believe. The
        // headline owns the working stance — you hand over the work, the agent does it, nothing lands
        // without you — and says it in words nobody has to translate. "Agents", not "They": the line
        // used to name nothing in the system on purpose, and the pronoun paid for that by having no
        // antecedent anywhere above the fold. A reader who did not already know the category had
        // nothing to resolve it against, so the first screen read as a stance with no subject.
        headlineLines: ["You delegate. Agents work.", "You approve."],
        // Two beats: what the thing IS, then the claim the board underneath proves. The category
        // noun sits here rather than in the headline because the headline is a stance, and a stance
        // needs a subject the reader already holds — the first screen was supplying none, and that
        // is the one thing strangers reliably bounced on ("I read the whole page and still don't
        // know what it does"). Visibility is what the headline leaves out: "You approve" is a gate
        // at the end, this is the whole run, watched while it happens and interruptible mid-thought.
        // Scale is still shown rather than SAID — the shot below is a full board, and "ten agents at
        // once" was the most crowded sentence in the category. Ownership still stays out (it answers
        // a fear instead of creating a want) and persistence still lives in the meta description and
        // the bands, because framing it as the reader walking away argued against the co-piloted
        // stance the headline just set.
        subhead: "A workspace for coding agents. Nothing happens out of sight.",
        /* THE LITERAL SENTENCE, under the two persuasive ones. The headline is a stance and the subhead is a
         * category noun plus a claim; neither ever says the mechanism, because saying it costs the opener its
         * edge. So it is said here instead, one step down the page, in words a reader already holds — parallel,
         * branch, review — instead of the ones the copy used to lead with (container, worktree). Those two are
         * accurate and still show up on the pages a search sends you to (guides, docs, the Run page), where the
         * reader arrived already knowing the concept. The home page pays the human cost of them and gets very
         * little back, because a stranger reading "in its own container and git worktree" on the first screen
         * hears an engineering spec instead of a promise.
         *
         * It is not a fourth persuasive beat and must not become one. It names what the product does and stops.
         * Ownership stays out by the standing rule and is carried by the chip below, which is crawlable text on
         * the same screen — the concept is present without the opener paying for it. */
        summary: "Run many coding agents on your own machine, each on its own branch, and read every change on its way in.",
        // "Works with Claude, Codex and Grok" replaces "Bring your own agent": the old chip asked the
        // reader to already know what an agent is and that they have one, which is the assumption the
        // whole first screen was making. Three names they recognise do the same job with no decoding.
        chips: ["Free and open source", "Works with Claude, Codex and Grok", "Runs on your own machine"],
        screens: {
            app: [
                {
                    name: "hero-agents",
                    alt: "The intentic fleet board: an Attention lane holding a Front Desk question and an agent asking one of its own, an Active lane with an agent running a Stripe checkout under two subagents, and a Finished lane where a completed change offers Land now. Each card shows its model, branch, cost and diff stats.",
                    frameLabel: "acme-shop · /agents",
                },
                {
                    name: "hero-changes",
                    alt: "The workspace's Changes tab: the working tree grouped by repository — three files under web, two under api, each with its branch and its own insertions and deletions — beside a side-by-side diff of CheckoutPanel.tsx.",
                    frameLabel: "acme-shop · /workspace",
                },
                {
                    name: "hero-pipelines",
                    alt: "The Pipelines view: CI runs from a GitHub repo and a GitLab repo on one board, five passed, one running and one failed, at an 83% pass rate, each row drawing the circles of its own jobs.",
                    frameLabel: "acme-shop · /pipelines",
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
    // The tour: five verbs, each said once, each a picture instead of a paragraph. Order matches the
    // Features menu. Orchestrate leads at full width because the board is the product's face; the other
    // four are compact cards. Automate carries its trigger list, not a screenshot: it is diagram-led
    // everywhere, because no honest capture of an automations screen exists.
    verbs: {
        eyebrow: "A day at the board",
        // The heading is a picture, not a to-do list. The previous version read "Run agents. Connect
        // your tools. Read every change." — three verbs in a row that a stranger scanning the second
        // screen took for a chore chart, which is the opposite of the excitement the page is trying to
        // build. The heading now names the artefact the reader is about to see (a board) and the
        // asymmetry that makes it interesting (many agents, one gatekeeper). The sub spends its line
        // on the one mechanical fact that makes "many at once" believable, in the words a reader
        // already holds rather than one they would have to look up.
        heading: "One board holds every agent working for you.",
        sub: "Each writes on a branch of its own, so many can share a repo without stepping on each other.",
        items: [
            {
                verb: "Run",
                href: productHref("run"),
                line: "One board shows every agent you have running, and puts the one that needs you first.",
                shot: {
                    name: "fleet-board",
                    alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane where a completed agent offers Land now. Every card shows model, branch, tokens, cost and diff stats.",
                    label: "acme-shop · /agents",
                },
            },
            {
                verb: "Connect",
                href: productHref("connect"),
                line: "Connect an agent to GitHub, Postgres, Stripe, Discord or any MCP server. Your keys stay on your machine.",
                shot: {
                    name: "capabilities",
                    alt: "The capability catalog grouped by Platform, Code & issues, Observability, Data and Communication, with GitHub, Sentry, PostgreSQL, Discord, Docker and SSH marked as connected.",
                    label: "acme-shop · /capabilities",
                },
            },
            {
                verb: "Automate",
                href: productHref("automate"),
                line: "Start an agent automatically on an event you pick. Every run is one you can open and watch.",
                triggers: ["a push", "a Sentry alert", "a Stripe payment", "inbound email", "a chat message", "a schedule"],
            },
            {
                verb: "Review",
                href: productHref("review"),
                line: "The agent writes a plan and waits for your yes. Finished work sits on its branch until you read the diff.",
                shot: {
                    name: "workspace-changes",
                    alt: "The workspace Changes tab: five uncommitted files grouped by repo with their line counts, and the diff of one of them open beside the list.",
                    label: "acme-shop · /workspace",
                },
            },
            {
                verb: "Host",
                href: productHref("host"),
                line: "Move the workspace to a server so it runs without your laptop, and invite your team into the same one.",
                shot: {
                    name: "sandbox-overview",
                    alt: "The sandbox hub: the acme-shop sandbox shown online with its installed version and its own URL, beside the list of everything it holds: environment, secrets, agent account, extensions, access, personas and computers.",
                    label: "acme-shop · /sandbox",
                },
            },
        ],
        cta: "Every feature, in detail",
    },
    // Replaces the ownership ledger (retired 2026-08-15). That band spent the page's third screenful
    // answering a fear the reader had not had yet, in a heading that was a slogan ("Your code never
    // leaves your machine"), and its argument was already made in full by the first trust card below,
    // qualifier and link included. The slot goes to the question the hero actually raises: the hero
    // promises you approve everything, so this is where the page shows what you approve WITH. The claim
    // is a COMPARISON, so it is made as one: two columns of nouns, where the asymmetry carries it.
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
            // Two items and a short closing line, so this card stays visibly the shorter of the two.
            // The silhouette is half the argument: a longer thin card would say the opposite of the band.
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
        // "intentic" stays lowercase at the start of a sentence: that is the standing rule in
        // messaging.md, and the app, the docs and every other band already do it.
        heading: "intentic is free. Agents use AI plans you already pay for.",
        sub: "You bring the AI plans, your machine does the work, and there is nothing to pay us.",
        // `logo` is the provider's own brand mark, the same five the app draws beside every session. The
        // paths live in @intentic/constants so the two surfaces cannot drift apart.
        accounts: [
            { name: "Claude", logo: "claude", detail: "Opus, Sonnet and Haiku, on your Claude plan" },
            { name: "Codex", logo: "codex", detail: "on your ChatGPT plan" },
            { name: "Grok", logo: "grok", detail: "on your SuperGrok plan" },
            { name: "Kimi Code", logo: "kimi", detail: "on your Kimi Membership" },
            { name: "Google", logo: "gemini", detail: "Gemini, Claude and GPT-OSS, free on a Google sign-in" },
        ],
        points: [
            "We never meter your tokens or add a markup.",
            "No cloud compute to rent. Agents run on the machine you start them on.",
            "Everything is included. No tiers, no limits, no card.",
        ],
    },
    // The name, bio, links and cards all live in about.ts: shared with /about/, so the two surfaces
    // cannot drift. Only the band's own framing is here.
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
                // Step 2 is where "sandbox" first meets a reader who has never seen the word, so it is
                // defined there rather than assumed. It is the only noun the product uses for the thing,
                // and it is defined in plain words instead of via "container", which is the same fix the
                // hero summary made one screen up: the definition should be shorter than the word.
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
        desktop: {
            lead: "Rather not touch a terminal?",
            cta: "Get the app for Windows or Linux",
            // Says what it IS, so nobody reads it as a different product: the same install with a window
            // around it. The Mac reader is not stranded: the command above is what the app runs anyway.
            note: "It runs the same command for you: Docker if the machine needs it, then the sandbox, then your workspace.",
        },
    },
    finalCta: {
        // Persistence closes the page: it is the one claim that lives nowhere else on the scroll now,
        // and at the bottom it reads as a reason to start rather than a reason to walk away.
        heading: "Put ten agents to work today.",
        sub: "It is free, it runs on your own machine, and the work carries on when you close the browser.",
    },
};
