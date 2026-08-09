import { docsHref } from "./docs";
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

/** A labeled row of tags in the sandbox figure (e.g. "Environment" → toolchain). */
export interface AgentSpecRow {
    label: string;
    items: string[];
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
 * One beat of the loop. Same shape as a `ProductBlock`: the proof beside the words is a real captured
 * surface, or — where no single screen shows the thing — a figure drawn in markup. Never a mockup.
 * A browser-framed shot carries the title-bar pill; a phone-framed one fills the phone shell whole,
 * because a 430px-wide capture in a browser frame reads as a cropped desktop.
 */
export interface LoopBeat {
    /** The ghost numeral beside it. Authored, so the copy owns its own ordering. */
    step: string;
    title: string;
    body: string;
    shot?: ShotImage & ({ frame: "browser"; frameLabel: string } | { frame: "phone" });
    figure?: "sandbox";
}

/**
 * One tile of the extend bento: a superpower, one line about it, and the page that owns it. The first
 * tile is the grid's big cell and is the only one given `triggers` — that list is what fills a 2×2 cell
 * honestly, instead of padding the other five out to match it.
 */
export interface ExtendTile {
    name: string;
    body: string;
    href: string;
    triggers?: { label: string; items: string[] };
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
    /* The spine: assign several → each works isolated in a sandbox of its own → nothing lands unread.
     * This is the section that earns the headline's second half — it is the window. */
    loop: LandingSectionIntro & {
        beats: LoopBeat[];
        // The container figure that beat 02 stands on: an agent on a machine you own, tools installed.
        sandbox: { boundary: string; agent: { name: string; role: string }; layers: AgentSpecRow[] };
        cta: string;
    };
    ownership: LandingSectionIntro & { ledger: OwnershipLedger };
    economics: LandingSectionIntro & { accounts: { name: string; detail: string }[]; points: string[] };
    /* Everything the product can also be, in one screen of tiles that link out. It is here so the
     * flexibility is stated rather than demonstrated: nine sections of "and also" is what made a visitor
     * lose the thread, and the honest framing is the one in _extensions/README.md — a lean core plus
     * extensions. Nothing in this band argues; each tile hands the reader to the page that owns it. */
    extend: LandingSectionIntro & { tiles: ExtendTile[]; note: string; cta: string };
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
// have read the diff. Every section below is a proof of that sentence or an objection to it. What the
// product can ALSO do — Doorbell, Discord, automations, sharing, a whole company of agents — is real,
// has pages of its own, and lives in one quiet band near the bottom.
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
        // Short on purpose: the hero states the claim, and #loop is where each half of it gets proved.
        // "Look away", not "log off" — nothing has to be ended for the runs to continue; the browser
        // simply holds nothing they depend on.
        subhead:
            "Your agents live on hardware you own and keep running when you look away. Every browser is a window onto the same fleet — steer, approve, interrupt, land.",
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
    loop: {
        eyebrow: "The loop",
        heading: "Run several at once. Land them one at a time.",
        sub: "The parallel half is safe by construction: one sandbox and one worktree each. The deciding half stays yours. Works with Claude Code, Codex, Grok, Kimi Code and Google.",
        beats: [
            {
                step: "01",
                title: "Give the work to as many agents as it needs",
                body: "Each starts in plan mode on a git worktree cut from your base commit. The board sorts them by who needs you; the rest keep running while you answer.",
                shot: {
                    name: "fleet-board",
                    alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane offering Land now. Every card shows model, branch, tokens, cost and diff stats.",
                    frame: "browser",
                    frameLabel: "acme-shop · /agents",
                },
            },
            {
                step: "02",
                title: "Each works in a sandbox of its own",
                body: "Not a chat window: a container on your machine, with the job's toolchain really installed and its context loaded every turn. It never touches your working tree.",
                figure: "sandbox",
            },
            {
                step: "03",
                title: "Walk away — the runs don't stop",
                body: "The agents live on your machine, not in this tab. Close the laptop, open your phone on the train: the same board, the same runs, the one that needs an answer on top.",
                shot: {
                    name: "mobile-fleet",
                    alt: "The same fleet board on a phone: the Attention lane on top with the agent that needs an answer, the Active lane below it, every card with the same model, branch, cost and diff stats.",
                    frame: "phone",
                },
            },
            {
                step: "04",
                title: "Nothing lands until you have read the diff",
                body: "Finished work arrives as a branch: every changed file, every hunk, the tests it ran. Land it as ordinary git changes, or discard it and the worktree goes too.",
                shot: {
                    name: "agent-review",
                    alt: "The isolated review panel: four changed files with per-file line counts, a split diff of a database schema adding a deletedAt column, and a Land now button beside the agent's branch name.",
                    frame: "browser",
                    frameLabel: "acme-shop · agent/soft-deletes",
                },
            },
        ],
        sandbox: {
            boundary: "your machine · reached from your browser over a private tunnel",
            agent: { name: "release-captain", role: "owns the weekly release" },
            layers: [
                { label: "Environment · installed", items: ["node 24", "pnpm", "docker", "psql"] },
                { label: "Context · loaded every turn", items: ["6 skills", "release runbook", "house style"] },
            ],
        },
        cta: "Every surface, with the screenshots",
    },
    // The old version of this band argued the point in three paragraphs standing under a three-box
    // diagram, and a reader had to assemble the claim themselves. The claim is a COMPARISON — your
    // hardware holds everything, the platform holds two fields — so it is made as one: two columns of
    // nouns, side by side, where the asymmetry is the argument and needs no prose to carry it.
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
        sub: "Ten agents sounds expensive. It isn't. Each runs on a subscription you already pay for, on hardware you already own.",
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
    extend: {
        eyebrow: "Extend it",
        heading: "A small core. Everything else is an extension.",
        sub: "The workspace ships lean: the fleet, the sandbox, the editor, the review. Everything past that is an extension, allowed to do only what its manifest declares.",
        // Order is the grid's, not a ranking: the first tile is the big cell, so it goes to the one with
        // a list worth showing. The rest are equal-weight and read left to right.
        tiles: [
            {
                name: "Automations",
                body: "Agents that start themselves, so nobody has to be at a keyboard. Each run is a fresh session with its own transcript, gated by a guard command you write, and one agent's run can wake the next.",
                triggers: {
                    label: "Wakes on",
                    items: ["a push", "a Sentry alert", "a Stripe payment", "inbound email", "a chat message", "plain cron"],
                },
                href: productHref("automate"),
            },
            {
                name: "Discord & Slack",
                body: "Assign work with an @mention. It replies in the thread, with receipts.",
                href: productHref("empower"),
            },
            {
                name: "Doorbell",
                body: "Put an agent on your own website behind one script tag.",
                href: productHref("empower"),
            },
            {
                name: "Team sharing",
                body: "Invite teammates into one sandbox, each signed in as themselves.",
                href: productHref("delegate"),
            },
            {
                name: "Memory & pipelines",
                body: "Notes that outlive a run, CI it can fix, a preview per repo.",
                href: "/extensions/",
            },
            {
                name: "A whole company",
                body: "One agent per role and per team, sharing the services they all use.",
                href: docsHref("reference-architecture"),
            },
        ],
        note: "An extension adds tools, skills and image layers, not just UI. Yours stays in your own repo.",
        cta: "Browse every extension",
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
