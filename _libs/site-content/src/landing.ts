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
 * A screenshot with its intrinsic pixel size. The dimensions are not decoration: without them the
 * browser cannot reserve the box before the PNG arrives, and the page reflows around it.
 */
export interface ShotImage {
    src: string;
    alt: string;
    width: number;
    height: number;
}

/** The hero visual: the real fleet board, cropped by the frame to its Attention and Active lanes. */
export interface HeroShot extends ShotImage {
    /** The pill in the frame's title bar — where in the app this shot was taken. */
    frameLabel: string;
}

/* The invitation to stop looking at the screenshot and use the thing. The hero keeps the still image — it is the
 * LCP, and this page ships almost no JavaScript — and the demo is loaded only on the press. */
export interface HeroDemo {
    /** On the frame itself. Says what happens, because "Play" on a screenshot could mean a video. */
    playLabel: string;
    /** Under the button: what the visitor is about to get, and what it is not. */
    note: string;
    /** Where a narrow screen goes instead — an embedded IDE on a phone is not a demo, it is a maze. */
    newTabLabel: string;
}

/**
 * One beat of the loop. Same shape as a `ProductBlock`: the proof beside the words is a real captured
 * surface, or — where no single screen shows the thing — a figure drawn in markup. Never a mockup.
 */
export interface LoopBeat {
    /** The ghost numeral beside it. Authored, so the copy owns its own ordering. */
    step: string;
    title: string;
    body: string;
    shot?: ShotImage & { frameLabel: string };
    figure?: "sandbox";
}

/** One row of the extend band: a superpower, one line about it, and the page that owns it. */
export interface ExtendRow {
    name: string;
    body: string;
    href: string;
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
    ownership: LandingSectionIntro & { facts: LandingFact[] };
    economics: LandingSectionIntro & { accounts: { name: string; detail: string }[]; points: string[] };
    /* Everything the product can also be, in one screen of one-liners that link out. It is here so the
     * flexibility is stated rather than demonstrated: nine sections of "and also" is what made a visitor
     * lose the thread, and the honest framing is the one in _extensions/README.md — a lean core plus
     * extensions. Nothing in this band argues; each row hands the reader to the page that owns it. */
    extend: LandingSectionIntro & { rows: ExtendRow[]; note: string; cta: string };
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

// One claim, proven once: you run a fleet of coding agents in parallel on hardware you own, and nothing
// reaches your tree until you have read the diff. Every section below is a proof of that sentence or an
// objection to it. What the product can ALSO do — Doorbell, Discord, automations, sharing, a whole
// company of agents — is real, has pages of its own, and lives in one quiet band near the bottom.
export const landingContent: LandingContent = {
    meta: {
        // Under 160 characters: a search result truncates past that, and this one has to survive
        // the cut with the claim and the price still in it.
        title: "intentic — An IDE for your agents. A window for you.",
        description:
            "An IDE for your agents. Each gets its own sandbox and git worktree on hardware you own — run ten in parallel, read every diff before it lands. Free.",
    },
    hero: {
        headlineLines: ["An IDE for your agents.", "A window for you."],
        // Short on purpose: the hero states the claim, and #loop is where each half of it gets proved.
        // "Worktree", not "branch" — a branch is a name, and what keeps ten agents off each other is that
        // each has a checkout of its own (`_apps/sandbox/src/agents/worktrees.ts`).
        subhead:
            "Each agent works in its own sandbox and its own git worktree, on hardware you own. Run ten at once; nothing lands in your tree until you have read the diff.",
        chips: ["Free plan", "Bring your own agent", "Runs on your hardware"],
        shot: {
            src: "/assets/product/fleet-board.png",
            width: 2144,
            height: 1240,
            alt: "The intentic fleet board: an agent waiting on approval for a Stripe billing change and another with a question for you, beside three agents actively drafting a changelog and migrating queries — each card showing its model, branch, cost and diff stats.",
            frameLabel: "acme-shop · /agents",
        },
        demo: {
            playLabel: "Try the live workspace",
            note: "The real app, on a recorded workspace. Approve a plan, answer an agent, read a diff — nothing to install.",
            newTabLabel: "Open the live workspace",
        },
    },
    loop: {
        eyebrow: "The loop",
        heading: "Run several at once. Land them one at a time.",
        sub: "Autonomy still needs a human in it. So the parallel half is safe by construction — one sandbox and one git worktree each — and the deciding half stays yours. Works with Claude Code, Codex, Grok, Kimi Code and Gemini.",
        beats: [
            {
                step: "01",
                title: "Give the work to as many agents as it needs",
                body: "Each starts in plan mode on its own git worktree, cut from your base commit. The board sorts them by what needs you — a question, a plan waiting for approval, a land conflict — and everything else keeps running while you answer.",
                shot: {
                    src: "/assets/product/fleet-board.png",
                    width: 2144,
                    height: 1240,
                    alt: "The intentic fleet board: an Attention lane with an agent asking a question and one blocked on a land conflict, an Active lane with three agents running, and a Finished lane offering Land now — every card showing model, branch, tokens, cost and diff stats.",
                    frameLabel: "acme-shop · /agents",
                },
            },
            {
                step: "02",
                title: "Each works in a sandbox of its own",
                body: "Not a chat window — a container on your machine with the job's toolchain genuinely installed and its context loaded on every single turn. They never step on each other's files, and none of them touch your working tree.",
                figure: "sandbox",
            },
            {
                step: "03",
                title: "Nothing lands until you have read the diff",
                body: "Finished work arrives as a branch: every changed file, every hunk, the tests it ran. Land it into your tree as ordinary git changes you can still amend or revert — or discard it, and the worktree goes with it.",
                shot: {
                    src: "/assets/product/agent-review.png",
                    width: 2144,
                    height: 1800,
                    alt: "The isolated review panel: four changed files with per-file line counts, a split diff of a database schema adding a deletedAt column, and a Land now button beside the agent's branch name.",
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
    ownership: {
        eyebrow: "Ownership",
        heading: "Real access is only safe if you own where it runs.",
        sub: "An agent holding your keys and working your repos is worth having only if it runs somewhere you control. Each sandbox is a container on your own hardware, reached by your browser over a private tunnel. The platform stores your identity and a URL, and can't reach in.",
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
    economics: {
        eyebrow: "Economics",
        heading: "A whole fleet, on the subscriptions you already pay for.",
        sub: "Ten agents sounds expensive. It isn't. Each one runs on your own Claude, ChatGPT, SuperGrok, Kimi or Google account — connected once with a sign-in code — on hardware you already own. intentic is a flat subscription, never a meter on your model usage.",
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
    extend: {
        eyebrow: "Extend it",
        heading: "A small core. Everything else is an extension.",
        sub: "The workspace ships lean on purpose — the fleet, the sandbox, the editor, the review. Everything past that is an extension: a git repo with a manifest, allowed to do only what it declares. A few of the first-party ones, and where each is written up.",
        rows: [
            {
                name: "Automations",
                body: "Wake an agent on a push, an alert, a payment, an inbound email, a chat message, or plain cron.",
                href: docsHref("autonomous-employees"),
            },
            {
                name: "Discord & Slack",
                body: "Assign work with an @mention; it replies in the thread like a colleague, with the receipts.",
                href: productHref("capabilities"),
            },
            {
                name: "Doorbell",
                body: "Put the agent on your own website behind one script tag, with a read-only toolbox.",
                href: productHref("doorbell"),
            },
            {
                name: "Team sharing",
                body: "Invite teammates into the same sandbox, each reaching it over their own private tunnel.",
                href: productHref("sandbox"),
            },
            {
                name: "Memory, pipelines, previews",
                body: "Notes that persist between runs, CI runs it can fix, a dev-server panel per repo.",
                href: "/extensions/",
            },
            {
                name: "A whole company",
                body: "One co-piloted agent per role and per team, sharing the handful of services they all use.",
                href: docsHref("reference-architecture"),
            },
        ],
        note: "An extension extends the agent as well as the UI — new tools, new skills, new layers in the image. Yours stays in your repo; a registry is just a list of sha-pinned pointers.",
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
        sub: "Sign in, name the sandbox, paste one command on the machine that should host it. The workspace opens the moment the sandbox reports in — then you put your agents to work.",
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
        commandNote: "Nothing deployed, nothing exposed — just a workspace your agents can call home.",
    },
    finalCta: {
        heading: "Put ten agents to work. Read every diff.",
        sub: "One command to a live sandbox. Free to start, on your hardware.",
    },
};
