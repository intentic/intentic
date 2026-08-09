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
 * A screenshot, named by the shot `_tools/e2e/shots/capture.mts` wrote — `fleet-board` is
 * `_site/site/src/assets/product/fleet-board.png`. Only the name and the alt text are content: the file's
 * pixel size, format and variants belong to the build, which reads them off the file itself.
 */
export interface ShotImage {
    name: string;
    alt: string;
}

/** The hero visual: the real fleet board, cropped by the frame to its Attention and Active lanes. */
export interface HeroShot extends ShotImage {
    /** The pill in the frame's title bar — where in the app this shot was taken. */
    frameLabel: string;
}

/* The invitation to stop looking at the screenshot and use the thing. The hero keeps the still image — it is the
 * LCP, and this page ships almost no JavaScript — and the press is a link to the demo's own page, where an IDE
 * gets the whole viewport instead of a hole cut in a marketing page. */
export interface HeroDemo {
    /** On the frame itself. Says where the press goes, because "Play" on a screenshot could mean a video. */
    playLabel: string;
    /** Under the link: what the visitor is about to get, and what it is not. */
    note: string;
}

/**
 * One verb in the tour — the home page's single telling of what the product does. Each maps 1:1 to a page
 * in the Features menu and carries ONE line plus one proof: a real browser screenshot (`shot`, named like a
 * `ShotImage` and framed with the route it was taken on) OR, for Automate, the list of events it wakes on —
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
 * The ownership ledger: what sits on your hardware, against everything the platform holds. Two columns
 * of nouns rather than three paragraphs of argument — the claim is a comparison, so the shape that makes
 * it is a comparison.
 *
 * `platform.never` is one sentence rather than a list on purpose. As three more rows it made the
 * platform's card the taller of the two, which is the exact opposite of the point the band is making.
 */
export interface OwnershipLedger {
    yours: { label: string; note: string; items: string[] };
    platform: { label: string; note: string; holds: string[]; never: string };
    footnote: string;
}

export interface LandingContent {
    meta: { title: string; description: string };
    hero: {
        headlineLines: string[];
        subhead: string;
        chips: string[];
        shot: HeroShot;
        demo: HeroDemo;
    };
    /* The one telling of what you do with the product, in the same five verbs as the Features menu — so the
     * home page and the feature pages read as one product. It replaces the old "loop" beats and "extend"
     * bento, which between them said the same powers three times over. */
    verbs: LandingSectionIntro & { items: VerbTourItem[]; cta: string };
    ownership: LandingSectionIntro & { ledger: OwnershipLedger };
    economics: LandingSectionIntro & { accounts: { name: string; detail: string }[]; points: string[] };
    /* Who is behind the promises the page just made. It sits here, last before `#connect`, because the
     * conversion order is claim → proof → objection → action: `#ownership` answers the architectural
     * half of "can I trust this", and the human half is the objection still standing when `#connect`
     * says "paste this command on your machine".
     *
     * The cards come from `about.ts`, shared with /about/, and the commit numbers are measured from git
     * at build time — never authored. The band has no slot that can render a zero: an empty social-proof
     * counter is the one thing here that would cost more trust than it buys. */
    trust: { eyebrow: string; cta: string };
    connect: LandingSectionIntro & { steps: LandingFact[]; commandNote: string };
    finalCta: { heading: string; sub: string };
}

// One claim, proven once: your agents run on hardware you own, keep running when you look away, and
// any browser — or a phone — reopens onto the same fleet, with nothing reaching your tree until you
// have read the diff. The hero states it; the five verbs show it; the bands below answer the objections
// it raises (who owns what, what it costs, who builds it) and then hand you the one command to start.
export const landingContent: LandingContent = {
    meta: {
        // Under 160 characters: a search result truncates past that, and this one has to survive
        // the cut with the claim and the price still in it.
        title: "intentic · Workstation for your agents. A window for you.",
        description:
            "Agents on hardware you own that keep running when you close the browser. Reopen from any device, steer the fleet, read every diff before it lands. Free.",
    },
    hero: {
        headlineLines: ["Workstation for your agents.", "A window for you."],
        // Short on purpose: the hero states the claim, and the verbs are where each half of it gets shown.
        // "Look away", not "log off" — nothing has to be ended for the runs to continue; the browser
        // simply holds nothing they depend on.
        subhead:
            "Your agents live on hardware you own and keep running when you look away. Every browser is one window onto the same fleet — steer, approve, land.",
        chips: ["Free and open source", "Bring your own agent", "Runs on your hardware"],
        shot: {
            name: "fleet-board",
            alt: "The intentic fleet board: an agent waiting on approval for a Stripe billing change and another with a question for you, beside three agents actively drafting a changelog and migrating queries. Each card shows its model, branch, cost and diff stats.",
            frameLabel: "acme-shop · /agents",
        },
        demo: {
            playLabel: "Open the live workspace",
            note: "The real app on a recorded workspace. Approve a plan, answer an agent, read a diff. Nothing to install.",
        },
    },
    // The tour: five verbs, each said once, each a picture instead of a paragraph. Order matches the
    // Features menu. Orchestrate leads at full width because the board is the product's face; the other
    // four are compact cards. Automate carries its trigger list, not a screenshot — it is diagram-led
    // everywhere, because no honest capture of an automations screen exists.
    verbs: {
        eyebrow: "What you do",
        heading: "The whole product, in five verbs.",
        sub: "Not a longer feature list — one line and one screen each. Every card opens the page that proves it.",
        items: [
            {
                verb: "Orchestrate",
                href: productHref("orchestrate"),
                line: "Run ten agents at once. The board sorts the fleet into who's blocked, who's running, who's done — and surfaces the one that needs you.",
                shot: {
                    name: "fleet-board",
                    alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane where a completed agent offers Land now. Every card shows model, branch, tokens, cost and diff stats.",
                    label: "acme-shop · /agents",
                },
            },
            {
                verb: "Empower",
                href: productHref("empower"),
                line: "Wire an agent into GitHub, Postgres, Sentry, Stripe, Discord or any MCP server — it sees and acts, and the credential stays in your sandbox.",
                shot: {
                    name: "capabilities",
                    alt: "The capability catalog grouped by Platform, Code & issues, Observability, Data and Communication, with GitHub, Sentry, PostgreSQL, Discord, Docker and SSH marked as connected.",
                    label: "acme-shop · /capabilities",
                },
            },
            {
                verb: "Automate",
                href: productHref("automate"),
                line: "Agents that start themselves — on an event you choose, under a guard command you write, each run a fresh session you can watch.",
                triggers: ["a push", "a Sentry alert", "a Stripe payment", "inbound email", "a chat message", "plain cron"],
            },
            {
                verb: "Supervise",
                href: productHref("supervise"),
                line: "It plans first and you approve; finished work waits on its own branch until you have read every hunk of the diff.",
                shot: {
                    name: "workspace-changes",
                    alt: "The workspace Changes tab: five uncommitted files grouped by repo with their line counts, and the diff of one of them open beside the list.",
                    label: "acme-shop · /workspace",
                },
            },
            {
                verb: "Delegate",
                href: productHref("delegate"),
                line: "Give the workspace a server of its own and hand off end-to-end operation — the sandbox runs on hardware you own, the platform off the command path.",
                shot: {
                    name: "sandbox-overview",
                    alt: "The sandbox hub: the acme-shop sandbox online with its installed version and URL, and an at-a-glance list of its agent account, secrets, capabilities, running services and access.",
                    label: "acme-shop · /sandbox",
                },
            },
        ],
        cta: "Every feature, in detail",
    },
    // The claim here is a COMPARISON — your hardware holds everything, the platform holds two fields — so
    // it is made as one: two columns of nouns, side by side, where the asymmetry is the argument and needs
    // no prose to carry it.
    ownership: {
        eyebrow: "Ownership",
        heading: "Your code never leaves your machine.",
        sub: "An agent with your keys is only safe if you own where it runs. Here is exactly what sits on each side.",
        ledger: {
            yours: {
                label: "Your machine",
                note: "Where the sandbox runs.",
                items: [
                    "Your repositories and working tree",
                    "API keys, .env files, database passwords",
                    "The agents, their sandboxes, their history",
                    "Every file an agent reads or writes",
                ],
            },
            platform: {
                label: "The intentic platform",
                note: "Everything it stores, in full.",
                holds: ["Your email address", "Your sandbox's URL"],
                never: "No code, no keys, and no way to command your agents.",
            },
            footnote:
                "Your browser holds the token that drives the sandbox; the platform never does. All of intentic is MIT on GitHub, platform included, so you can check.",
        },
    },
    economics: {
        eyebrow: "Economics",
        heading: "A whole fleet, on the subscriptions you already pay for.",
        sub: "Ten agents sounds expensive. It isn't: each runs on a plan you already have, on hardware you already own.",
        accounts: [
            { name: "Claude", detail: "Opus, Sonnet and Haiku, on your Claude plan" },
            { name: "Codex", detail: "on your ChatGPT plan" },
            { name: "Grok", detail: "on your SuperGrok plan" },
            { name: "Kimi Code", detail: "on your Kimi Membership" },
            { name: "Google", detail: "Gemini, Claude and GPT-OSS, free on a Google sign-in" },
        ],
        points: [
            "No per-token metering. No markup on your model usage.",
            "No rented cloud compute. Agents run where you run them.",
            "Free, whole: every sandbox, capability and shared workspace included.",
        ],
    },
    // The name, bio, links and cards all live in about.ts — shared with /about/, so the two surfaces
    // cannot drift. Only the band's own framing is here.
    trust: {
        eyebrow: "About the creator",
        cta: "More about who builds this",
    },
    connect: {
        eyebrow: "Get connected",
        heading: "One command, and an agent has a home.",
        sub: "Sign in, then paste one command on the machine that should host it. The workspace opens the moment it reports in.",
        steps: [
            {
                title: "Sign in with Google",
                body: "No forms, no card. It stores your identity and the sandbox's URL, nothing else.",
            },
            {
                title: "The sandbox is waiting",
                body: "Made and named for you, with a private tunnel under intentic's own domain. No Cloudflare account needed.",
            },
            {
                title: "Paste one command",
                body: "A one-liner starts the sandbox on your machine. Docker installs if missing, with your say-so.",
            },
        ],
        commandNote: "Nothing deployed, nothing exposed. Just a workspace your agents can call home.",
    },
    finalCta: {
        heading: "Put ten agents to work. Come back whenever.",
        sub: "One command to a live sandbox on your hardware. Free — and nothing lands until you have read the diff.",
    },
};
