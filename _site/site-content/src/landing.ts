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

/** The hero visual: the real fleet board, cropped by the frame to its Attention and Active lanes. */
export interface HeroShot extends ShotImage {
    /** The pill in the frame's title bar. Where in the app this shot was taken. */
    frameLabel: string;
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
 * The ownership ledger: what sits on your hardware, against everything the platform holds. Two columns
 * of nouns rather than three paragraphs of argument: the claim is a comparison, so the shape that makes
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
    /* The one telling of what you do with the product, in the same five verbs as the Features menu. So the
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
// have read the diff. The hero states it; the five verbs show it; the bands below answer the objections
// it raises (who owns what, what it costs, who builds it) and then hand you the one command to start.
export const landingContent: LandingContent = {
    meta: {
        // Under 160 characters: a search result truncates past that, and this one has to survive
        // the cut with the claim and the price still in it.
        title: "intentic · A workspace for coding agents",
        description:
            "A workspace for coding agents on hardware you own. They keep running when you close the browser. Reopen anywhere, read every diff before it lands. Free.",
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
        chips: ["Free and open source", "Bring your own agent", "Runs on your hardware"],
        shot: {
            name: "fleet-board",
            alt: "The intentic fleet board: an agent with a question for you and one blocked on a land conflict, beside three running on a Stripe checkout, a reviewed change and a latency spike, and three finished waiting to land. Each card shows its model, branch, cost and diff stats.",
            frameLabel: "acme-shop · /agents",
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
        eyebrow: "What you do",
        heading: "Run a fleet. Stay in control.",
        sub: "Run them, wire them to your systems, wake them on events, read every change.",
        items: [
            {
                verb: "Run",
                href: productHref("orchestrate"),
                line: "The board holds every agent at once and brings the one that needs you to the front.",
                shot: {
                    name: "fleet-board",
                    alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane where a completed agent offers Land now. Every card shows model, branch, tokens, cost and diff stats.",
                    label: "acme-shop · /agents",
                },
            },
            {
                verb: "Connect",
                href: productHref("empower"),
                line: "Give an agent GitHub, Postgres, Stripe, Discord or any MCP server. The keys stay in your sandbox.",
                shot: {
                    name: "capabilities",
                    alt: "The capability catalog grouped by Platform, Code & issues, Observability, Data and Communication, with GitHub, Sentry, PostgreSQL, Discord, Docker and SSH marked as connected.",
                    label: "acme-shop · /capabilities",
                },
            },
            {
                verb: "Automate",
                href: productHref("automate"),
                line: "Wake an agent on an event you pick. Each run opens a fresh session you can watch.",
                triggers: ["a push", "a Sentry alert", "a Stripe payment", "inbound email", "a chat message", "plain cron"],
            },
            {
                verb: "Review",
                href: productHref("supervise"),
                line: "It plans first and you approve. Finished work waits on its branch until you have read the diff.",
                shot: {
                    name: "workspace-changes",
                    alt: "The workspace Changes tab: five uncommitted files grouped by repo with their line counts, and the diff of one of them open beside the list.",
                    label: "acme-shop · /workspace",
                },
            },
            {
                verb: "Host",
                href: productHref("delegate"),
                line: "Give the workspace its own server and hand off the day-to-day. It stays under your control.",
                shot: {
                    name: "sandbox-overview",
                    alt: "The sandbox hub: the acme-shop sandbox shown online with its installed version and its own URL, beside the list of everything it holds: environment, secrets, agent account, extensions, access, personas and computers.",
                    label: "acme-shop · /sandbox",
                },
            },
        ],
        cta: "Every feature, in detail",
    },
    // The claim here is a COMPARISON: your hardware holds everything while the platform holds two fields, so
    // it is made as one: two columns of nouns, side by side, where the asymmetry is the argument and needs
    // no prose to carry it.
    ownership: {
        eyebrow: "Ownership",
        heading: "Your code never leaves your machine.",
        // The qualifier is load-bearing, not lawyering: the hosted starter box is a machine WE pay for, so for
        // that one lane the heading above is not true, and an unqualified version of it is a claim the terms
        // and the privacy policy would both have to contradict.
        sub: "What stays on your machine, and everything the platform stores. (Take the sandbox we host instead, and the workspace lives on our provider's disk — /privacy says exactly what that means.)",
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
            footnote: "Your browser, not the platform, holds the token that drives the sandbox. The full source is MIT-licensed on GitHub.",
        },
    },
    economics: {
        eyebrow: "Economics",
        heading: "A whole fleet, on the subscriptions you already pay for.",
        sub: "Ten agents sounds expensive. Each one runs on a plan you already pay for.",
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
    // The name, bio, links and cards all live in about.ts: shared with /about/, so the two surfaces
    // cannot drift. Only the band's own framing is here.
    trust: {
        eyebrow: "About the creator",
        cta: "More about who builds this",
    },
    connect: {
        eyebrow: "Get connected",
        heading: "One command, and an agent has a home.",
        sub: "Sign in, paste one command, and the workspace opens the moment it answers.",
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
        commandNote: "This deploys nothing and opens no inbound ports. It creates a workspace for your agents.",
        desktop: {
            lead: "Rather not touch a terminal?",
            cta: "Get the app for Windows or Linux",
            // Says what it IS, so nobody reads it as a different product: the same install with a window
            // around it. The Mac reader is not stranded: the command above is what the app runs anyway.
            note: "It runs the same command for you: Docker if the machine needs it, then the sandbox, then your workspace.",
        },
    },
    finalCta: {
        heading: "Put ten agents to work. Come back whenever.",
        sub: "One command, and it is free. Nothing lands until you have read the diff.",
    },
};
