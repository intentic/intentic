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

/* THE HERO VISUAL: two windows, because that is what this product looks like in use, the workspace in one,
 * and the chat lifted out of it into another (the app's own pop-out). One still frame of a fleet board could
 * only ever make one of the page's claims; a workspace beside a live conversation makes the whole of it.
 *
 * THE CENTRE FRAME CYCLES `app`, in the order written here; the wings hold stills (see Landing.astro). `app`
 * is two CALM surfaces on purpose: the board of plain-English tasks, then one of those tasks finished and
 * waiting to land — the whole "you delegate, you approve" claim, without opening the first impression on a raw
 * code diff or a CI board, which read as a wall of code and a wall of dots to a stranger meeting the product
 * cold. The first of each list is the one a stranger sees first, so `app` opens on the board, which is the
 * page's subject, and `chat` opens on the agents cut, the conversation the board's cards lead to.
 *
 * The frames CROP their screens rather than fitting them (see Landing.astro): every capture is one window
 * height and the surfaces inside are different lengths, so what a reader sees is the top of each. */
export interface HeroScreens {
    /** The workspace window, behind and larger. */
    app: HeroScreen[];
    /** The chat, in the window the product pops it out into, in front, smaller, overlapping. */
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
 * `ShotImage` and framed with the route it was taken on) OR, for Automate, the machine it wakes by, drawn:
 * that page's screen exists, and a list of five configured automations is a picture of the RESULT of the
 * machine rather than of its shape.
 *
 * EVERY ITEM GETS THE SAME SIZE, and the tour is read one item per screenful. There is no lead item and
 * no compact one: four verbs were cards with their screenshot cropped to a strip, which showed a
 * thirteenth of four surfaces and made the section unreadable at exactly the point it was meant to be
 * showing the product.
 */
export interface VerbTourItem {
    verb: string;
    href: string;
    line: string;
    shot?: { name: string; alt: string; label: string };
    /**
     * Automate's proof, and it is a machine rather than a picture: what wakes a run, what gets to veto it,
     * and what the run turns out to be, drawn as three stations on a rail (`AutomateFigure.astro`).
     *
     * A SWITCH, NOT THE CONTENT. The machine's own words live in `site-content/automate.ts`, because the
     * feature page draws the same three stations and a reader who meets the diagram twice should meet the
     * same claim twice. All this slot decides is that this stage carries the drawing instead of a screenshot.
     */
    figure?: "automate";
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
        screens: HeroScreens;
        demo: HeroDemo;
    };
    /* The one telling of what you do with the product, in the same five verbs as the Features menu. So the
     * home page and the feature pages read as one product. It replaces the old "loop" beats and "extend"
     * bento, which between them said the same powers three times over.
     *
     * THE ONLY BAND OPENER ON THE PAGE WITH NO `sub`, and the pictures under it are why. The section is a
     * showcase now — one verb, one screenful, one screenshot at the width of the window — so everything
     * between the hero and the first of those screenshots is read INSTEAD of it. An eyebrow, the same label
     * style as the bands below, is all that fits there. The one mechanical fact the retired sub
     * carried (an agent works on a branch of its own) is still on the page: `#workspace` closes on it. */
    verbs: Omit<LandingSectionIntro, "sub" | "heading"> & { heading?: string; items: VerbTourItem[]; cta: string };
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
        /* The other two machines, as a LINK rather than a fork. The band shows one command on one machine —
         * the reader's own — because that is the machine the product is about and the one the argument above
         * was made for. Opening a three-way infrastructure decision here would put the page's hardest
         * question one paragraph before the FAQ, in front of a reader who has just been convinced. Whoever
         * is not sure this is their machine follows the line; everyone else reads past it. */
        commandChoice: { lead: string; cta: string };
        desktop: { lead: string; cta: string; note: string };
    };
}

// One claim, proven once: your agents keep running when you look away, and
// any browser, including a phone, reopens onto the same fleet, with nothing reaching your tree until you
// have read the diff. The hero states it; the five verbs show it; `#workspace` shows what you read it
// WITH; the bands below answer the objections it raises (what it costs, who builds it) and then hand
// you the one command to start.
export const landingContent: LandingContent = {
    meta: {
        // Title under 60 characters, description under 160: a search result truncates past those. The
        // title spends its spare room on the one word strangers filter on.
        title: "intentic · Open-source workspace for coding agents",
        description: "A workspace for coding agents. They keep running when you close the browser. Reopen anywhere and review every change. Free.",
    },
    hero: {
        // Three beats, split 2 + 1 so the second line lands the one the reader has to believe. The
        // headline owns the working stance, you hand over the work, the agent does it, nothing lands
        // without you, and says it in words nobody has to translate. "Agents", not "They": the line
        // used to name nothing in the system on purpose, and the pronoun paid for that by having no
        // antecedent anywhere above the fold. A reader who did not already know the category had
        // nothing to resolve it against, so the first screen read as a stance with no subject.
        headlineLines: ["You delegate. Agents work.", "You approve."],
        // What the thing IS, in one sentence: nothing else above the fold names the category, and that is
        // what strangers bounced on. Visibility is carried by the three live surfaces beside it, not by a
        // second sentence. A literal restatement under it, a row of fact chips under the buttons and an
        // authored closing band were all tried and cut (2026-09-06, landing-blueprint.md): no slots for them.
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
    // The tour: five verbs, each said once, each a screenful of its own with the screen itself at the
    // width of the window. Order matches the Features menu. Automate carries its own machine rather than
    // a screenshot: it is diagram-led everywhere, because no honest capture of an automations screen
    // exists and a mockup would be the one lie on this page.
    verbs: {
        eyebrow: "What you do",
        /* One eyebrow, same class as "Why a workspace", then the first verb. No carved heading under it —
         * the five verbs and their screenshots make the argument. */
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
                /* The one stage on the tour with no screenshot in it, so it carries the machine instead:
                 * what wakes a run, the code of yours that gets to veto it, and what a run turns out to
                 * be. The middle part is the one nobody expects and the reason this is a diagram rather
                 * than a list — an event does not start an agent, your own check does. */
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
        // `logo` is the provider's own brand mark, the same set the app draws beside every session. The
        // paths live in @intentic/constants so the two surfaces cannot drift apart.
        accounts: [
            { name: "Claude", logo: "claude", detail: "Opus, Sonnet and Haiku, on your Claude plan" },
            { name: "Codex", logo: "codex", detail: "on your ChatGPT plan" },
            { name: "Grok", logo: "grok", detail: "on your SuperGrok plan" },
            { name: "Kimi Code", logo: "kimi", detail: "on your Kimi Membership" },
            { name: "Google", logo: "gemini", detail: "Gemini, Claude and GPT-OSS, free on a Google sign-in" },
            // Named for the PLAN rather than the account, like the others, and here that distinction is load
            // bearing: a free Cursor account signs in and still cannot run a turn, because the agent behind
            // this row is gated to the paid tiers.
            { name: "Cursor", logo: "cursor", detail: "Composer and the frontier models, on your Cursor Pro plan" },
            // The two rows connected by pasting a key rather than by signing in. Said in the detail line,
            // because "bring your own account" is the band's whole claim and a key is a different act from a
            // sign-in: the reader should know which one this row is asking of them before they click.
            { name: "Z.ai", logo: "zai", detail: "GLM, on your Coding Plan key" },
            { name: "Meta", logo: "meta", detail: "Muse Spark, on your Model API key" },
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
        // Named as a comparison, not as an alternative: "run it somewhere else" invites the reader to leave
        // the command they are looking at, while "one of two" tells them the command is a choice they are
        // allowed to check. The link goes to the page that states both trades in full.
        commandChoice: { lead: "This is one of two machines it can run on.", cta: "Compare them" },
        desktop: {
            lead: "Rather not touch a terminal?",
            cta: "Get the app for Windows or Linux",
            // Says what it IS, so nobody reads it as a different product: the same install with a window
            // around it. The Mac reader is not stranded: the command above is what the app runs anyway.
            note: "It runs the same command for you: Docker if the machine needs it, then the sandbox, then your workspace.",
        },
    },
};
