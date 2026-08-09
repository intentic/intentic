/* The comparison shelf: "how does intentic compare to X?", answered honestly and once per X.
 *
 * The naive answer — a feature matrix where every row is a tick for us — is the fastest way to lose the
 * credibility the rest of the site is built on. So the shelf is organised around a fact that is true and
 * disarming: MOST of the tools people name are not competitors. The agent CLIs are harnesses this product
 * runs; the editors keep working through desktop sync; the assistants do a different job on the same
 * hardware; the local orchestrators share the instinct and intentic goes a layer deeper; only the cloud
 * platforms are a real either/or.
 *
 * Since these first shipped the field has CONVERGED — Cursor, Claude Code, Conductor and others grew their
 * own cloud or background agents, so "we have agents and they don't" is no longer true anywhere. What stays
 * true is the pair of axes the hub is built on: whose machine the agent runs on, and how much of its
 * environment you can change. Every page is written to those.
 *
 * Accuracy rules, because these describe other people's products and those products move weekly:
 * - Quote their own words for what they are (`theirPitch`), and link `url` so a reader can check.
 * - Every fact was re-verified against the vendor's own live site on the datePublished below.
 * - No invented numbers; where a vendor does not state something (a licence, a price), the page does not either.
 * - Every table carries rows that go the other way (`theirs`). A table with no losing rows is one nobody believes.
 */

export const compareHref = (slug: string): string => (slug ? `/compare/${slug}/` : `/compare/`);

// Re-verified against every vendor's live site on this date. These products ship fast; this is a snapshot.
const PUBLISHED = "2026-08-09";

/** One kind of tool people confuse this product with — the unit the hub is organised in. */
export interface CompareFamily {
    id: string;
    label: string;
    /** The verdict for the whole bucket, in three or four words. It is the thing to remember. */
    verdict: string;
    body: string;
    /** Named so the hub answers for tools that will never have a page of their own. */
    examples: string[];
}

/** One line of the head-to-head table. */
export interface CompareRow {
    /** The dimension, phrased as the thing a reader is actually deciding about. */
    label: string;
    intentic: string;
    them: string;
    /** Set where the row goes the other way. These rows are why the table is worth reading. */
    theirs?: boolean;
}

export interface CompareSection {
    title: string;
    body: string;
}

export interface ComparePage {
    slug: string;
    /** The other product, spelled the way it spells itself. */
    name: string;
    /** Their site — every claim on the page has to be checkable there. */
    url: string;
    /** Nav and footer row. */
    navLabel: string;
    menuBlurb: string;
    family: string;
    heading: string;
    sub: string;
    /** What they are, close to their own words. Quoted where it is a direct lift. */
    theirPitch: string;
    /** The answer, before any table. One or two lines: if a reader stops here they should still have it. */
    verdict: string[];
    /** Where the two genuinely overlap. Written generously — it earns the right to the contrast. */
    overlap: CompareSection;
    /** The one or two distinctions that survive the table. Kept short; the table carries the detail. */
    differences: CompareSection[];
    table: CompareRow[];
    /** Present where the honest answer is "run both", with the mechanism that makes it true. */
    together?: CompareSection;
    /** The case for them. A real recommendation, not a strawman. */
    pickThem: string;
    meta: { title: string; description: string; datePublished: string };
}

export const compareFamilies: CompareFamily[] = [
    {
        id: "harnesses",
        label: "Agent CLIs",
        verdict: "intentic runs these",
        body: "A harness turns a model into an agent in your terminal: the loop, the tools, the permission prompts. It is the engine, not the garage. intentic is what one runs inside, with five built in and any ACP agent a capability away. Where a harness grows its own cloud — Claude Code on the web — the question becomes whose machine it runs on.",
        examples: ["Claude Code", "Codex", "Grok", "Kimi Code", "Gemini CLI", "OpenCode", "Goose", "Qwen Code"],
    },
    {
        id: "editors",
        label: "AI editors",
        verdict: "keep yours",
        body: "An AI editor puts you at the keyboard with a model helping. intentic puts the agent at the keyboard and you in review — desktop sync mirrors the sandbox onto your machine, so your editor opens what an agent just wrote. Several editors now add cloud agents of their own; there the split becomes whose infrastructure they run on.",
        examples: ["Cursor", "Windsurf", "VS Code + Copilot", "Zed", "JetBrains AI"],
    },
    {
        id: "assistants",
        label: "Personal AI assistants",
        verdict: "a different job",
        body: "An assistant lives in your chat apps and runs the rest of your life: the inbox, the calendar, the notes, the house — self-hosted, on your own accounts, which is the same conviction this product is built on. It is pointed elsewhere. intentic is for the work that ends in a diff, and an assistant that can call a webhook can start an agent here.",
        examples: ["OpenClaw", "Hermes", "Khoj", "Leon"],
    },
    {
        id: "orchestrators",
        label: "Local agent orchestrators",
        verdict: "same instinct, wider scope",
        body: "The closest neighbours, and the ones that got ownership right: several agents at once, each on its own worktree, on your hardware. Where intentic keeps going is the layer under the agent — the image it runs in, the credentials it operates, the events that wake it, the teammates who share it — and it stays free and MIT throughout while several of these now charge per seat.",
        examples: ["Conductor", "Superset", "T3 Code", "Synara", "Nimbalyst", "Crystal", "Vibe Kanban", "Sculptor"],
    },
    {
        id: "cloud",
        label: "Cloud agent platforms",
        verdict: "the opposite trade",
        body: "The only genuine either/or on this page. They run the agent on their infrastructure, so your source and your keys are cloned into their sandbox for the run. intentic gives the same browser experience with the sandbox on hardware you own.",
        examples: ["Devin", "Google Jules", "Codex cloud", "Claude Code on the web", "Replit Agent", "Cursor cloud agents"],
    },
];

export const comparePages: ComparePage[] = [
    {
        slug: "conductor",
        name: "Conductor",
        url: "https://conductor.build/",
        navLabel: "vs Conductor",
        menuBlurb: "Parallel agents on a Mac — versus a machine each agent configures",
        family: "orchestrators",
        heading: "Both run parallel agents. Only one hands each a machine it configures.",
        sub: "Conductor and intentic both run several coding agents at once, each isolated on its own branch. They part on what sits under the agent — and on the bill.",
        theirPitch: "“Run parallel Claude Code, Codex, and Cursor agents in isolated workspaces on your Mac.”",
        verdict: [
            "Conductor is a polished native Mac app for running many agents in parallel, and it has just added Conductor Cloud to offload them. If your agents only need the toolchain already on that Mac, it does the job well.",
            "intentic gives each agent a container of its own — an image you approve, credentials for your systems kept inside — on hardware you own, free, and MIT top to bottom.",
        ],
        overlap: {
            title: "Where you agree",
            body: "agents run in parallel, each isolated on its own branch, on your hardware and your own model subscription, with nothing merged until you have read the diff.",
        },
        differences: [
            {
                title: "A container, not your Mac as it is",
                body: "Conductor runs agents in your existing local environment, so an agent's reach is whatever you happen to have installed. In intentic each agent gets an overlay-Dockerfile image you read and approve, plus capabilities that hand it GitHub, Postgres, Sentry or any MCP server with the credential kept inside the sandbox.",
            },
            {
                title: "Free and MIT, not a seat you rent",
                body: "Conductor is free to start, but its cloud, multiplayer and teams sit behind $50–60/seat plans and its source is not published. Every part of intentic — sandbox, platform and CLI — is MIT and free, sharing included.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your Mac, or Conductor Cloud on a paid plan" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS" },
            { label: "Reach it from elsewhere", intentic: "any browser over a private tunnel, phone included", them: "the Mac, or Conductor Cloud (mobile app coming)" },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your local machine, as it already is",
            },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "your local shell" },
            { label: "Runs without you at the keyboard", intentic: "automations on cron, webhook, push, alert, email, chat", them: "background tasks in early access; you start each session" },
            { label: "Isolation", intentic: "one git worktree per agent", them: "one workspace and branch per task" },
            { label: "Price", intentic: "free — sandbox, platform, sharing, all of it", them: "free tier; cloud, multiplayer and teams from $50–60/seat" },
            { label: "A machine you do not have to provide", intentic: "you bring the hardware", them: "Conductor Cloud, nothing to host", theirs: true },
            { label: "Native desktop app", intentic: "native on Windows and Linux, browser elsewhere, plus desktop sync", them: "a refined native macOS app", theirs: true },
            { label: "Source you can read", intentic: "all of it — MIT on GitHub, platform included", them: "not published" },
        ],
        pickThem:
            "You work on one Mac, want a refined native app over a browser, your agents only ever need the toolchain already on that Mac, and you would rather click on Conductor Cloud than provide a machine.",
        meta: {
            title: "intentic vs Conductor · parallel agents, compared",
            description:
                "Both run parallel coding agents on your own hardware, each isolated on its own branch. Where they differ: the sandbox image, capabilities, automations, reach from any browser, and price — intentic is free and MIT throughout.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "superset",
        name: "Superset",
        url: "https://superset.sh/",
        navLabel: "vs Superset",
        menuBlurb: "The closest feature list — minus the machine underneath",
        family: "orchestrators",
        heading: "The nearest neighbour on this page. The difference sits a layer below the feature list.",
        sub: "Superset runs 100+ parallel agents, each in its own git worktree, with a diff viewer, terminals, an in-app browser, cron automations and an MCP server. What it does not hand an agent is a machine of its own.",
        theirPitch:
            "“Run 100+ parallel coding agents on your machine” — a source-available (Elastic License 2.0) desktop app that runs any CLI agent in its own isolated Git worktree.",
        verdict: [
            "Feature for feature this is the closest tool here, and the overlap is real: worktree isolation, scheduled runs, a diff between agent and tree, direct model keys with no proxy.",
            "Underneath, the bet is opposite. Superset's agents run in your local environment; each intentic agent gets a container built from an image you approve, with credentials for your systems kept inside it — and intentic is MIT and free where Superset is source-available under ELv2 with a paid Pro tier.",
        ],
        overlap: {
            title: "Where you agree",
            body: "agents run in parallel on hardware you own, each in its own git worktree, on the model subscription you already pay for — neither proxies a call or marks it up — with a diff between the agent and your tree and a way to start a run unattended.",
        },
        differences: [
            {
                title: "A container, not the Mac as you left it",
                body: "Superset shapes a workspace with setup and run scripts, but the tools those scripts reach for are whatever is on your machine. In intentic the machine is the artefact — an overlay Dockerfile you approve — so the agent that needs psql and a headless browser has them and your laptop does not.",
            },
            {
                title: "Credentials the agent operates",
                body: "Capabilities wire a sandbox to GitHub, PostgreSQL, Sentry, Discord, SSH or any MCP server, each keeping its secret inside the sandbox and injected per turn. Superset connects GitHub and Linear at the app level and otherwise leans on the keys already in your environment.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your local machine, in a git worktree each" },
            { label: "Parallel agents", intentic: "a fleet, sorted by which needs you", them: "100+ at once", theirs: true },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS; Linux experimental; Windows not yet" },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your machine and per-workspace setup scripts",
            },
            { label: "Where credentials live", intentic: "capabilities, kept inside the sandbox", them: "your environment; GitHub and Linear app connectors" },
            { label: "Runs without you at the keyboard", intentic: "cron, webhook, push, alert, email, chat, CI/CD, workspace events", them: "cron-like scheduled runs" },
            { label: "Reach it from elsewhere", intentic: "any browser over a private tunnel, phone included", them: "remote workspaces on Pro; mobile coming" },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "source-available (Elastic License 2.0)" },
            { label: "Price", intentic: "free, everything included", them: "free tier; Pro from $15–20/user, remote on Pro", theirs: true },
        ],
        pickThem:
            "You are on a Mac, want to push parallel agents into the triple digits today, your agents need only the toolchain that Mac already carries, and a source-available licence with a low per-seat Pro tier suits you better than a container you configure.",
        meta: {
            title: "intentic vs Superset · parallel agents, and the machine under them",
            description:
                "Superset runs 100+ parallel CLI agents in git worktrees on your Mac (ELv2, paid Pro). intentic gives each agent a container you configure, credentials kept inside, free and MIT throughout.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "t3-code",
        name: "T3 Code",
        url: "https://t3.codes/",
        navLabel: "vs T3 Code",
        menuBlurb: "Control the agents on your machine, or give them one",
        family: "orchestrators",
        heading: "T3 Code controls the agents on your machine. intentic gives each agent a machine.",
        sub: "Of everything here this shares the most premises: your subscription, your hardware, MIT top to bottom, and a genuinely great phone story. What is left over is the layer under the agent.",
        theirPitch:
            "“The open-source control plane for coding agents.” Orchestrate Claude Code, Codex, OpenCode, Cursor and Grok from one surface — desktop, web, and native iOS and Android. Bring your own subscription; fork the whole thing.",
        verdict: [
            "T3 Code drives the harnesses already installed on one computer, from a desktop, web and first-class iOS and Android apps that all talk to the server running there. It is MIT, free, and asks for nothing you are not already paying for.",
            "intentic agrees with all of that and then changes what an agent inherits: instead of your machine as it stands, a container built from an image you approve, capabilities that hand it your systems, and events that can start it while you are asleep.",
        ],
        overlap: {
            title: "Where you agree",
            body: "bring your own subscription — nothing resold or metered — the harness is a choice you can switch mid-thread, both are MIT so you can read the whole of what wraps your agent, and an agent you started at your desk is answerable from your pocket.",
        },
        differences: [
            {
                title: "What the agent inherits",
                body: "T3 Code launches the CLIs installed on the computer running its server, so an agent's reach is your reach: your PATH, your logins, your clients. In intentic the agent's machine is an image extended by an overlay Dockerfile you approve, and two agents on one host can carry entirely different toolchains.",
            },
            {
                title: "Systems, and running unwatched",
                body: "Capabilities wire a sandbox to GitHub, Postgres, Sentry, Stripe, SSH and MCP servers, each with its credential kept inside — and automations start a fresh session on a schedule or an event. T3 Code runs the threads you open, on the machine you open them on.",
            },
        ],
        table: [
            { label: "What it is", intentic: "the machine an agent works on", them: "a control surface for the agents on your machine" },
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your machine, against your local checkout" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS, Windows, Linux" },
            {
                label: "Harnesses",
                intentic: "Claude Code, Codex, Grok, Kimi Code or Google, plus any ACP agent",
                them: "Claude Code, Codex, OpenCode, Cursor, Grok",
            },
            { label: "On a phone", intentic: "the workspace on your home screen, with push notifications", them: "native iOS and Android apps", theirs: true },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your machine, as it already is",
            },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "your shell, one login per harness" },
            { label: "Isolation", intentic: "one git worktree per agent", them: "a branch per agent thread" },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "you start each thread" },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "MIT throughout" },
        ],
        pickThem:
            "Everything your agents need is already installed and signed in on the computer you use, you want a genuinely first-class native iOS and Android app over a browser tab, and you would rather run one MIT app — no container runtime, no account — than configure an environment.",
        meta: {
            title: "intentic vs T3 Code · a control plane, or the machine under it",
            description:
                "T3 Code drives the harnesses installed on your computer, from desktop, web and native iOS/Android — MIT and free. intentic gives each agent a container: an image you approve, credentials kept inside, events that wake it.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "synara",
        name: "Synara",
        url: "https://www.trysynara.com/",
        navLabel: "vs Synara",
        menuBlurb: "Nine agent runtimes in one window, or a machine each",
        family: "orchestrators",
        heading: "Synara runs nine agent runtimes in one window. intentic gives one agent a whole machine.",
        sub: "Both are free, local-first and fully open source, both isolate work in git worktrees, and neither goes near your tokens. They spend their effort at opposite ends of the same stack.",
        theirPitch:
            "“Run every coding agent in one workspace” — a free, open-source, local-first desktop workspace and control plane that wraps the provider runtimes already configured on your machine.",
        verdict: [
            "Synara invests in breadth at the top: nine runtimes — Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok Build, Kilo Code, Pi and Factory Droid — split chats, terminals, previews, worktrees and a one-action PR, with no account and no proxy.",
            "intentic invests in depth at the bottom: whichever harness you pick gets a container built from an image you approve, capabilities that hand it your repo, database and error tracker, and an event that can start it without you.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both run on hardware you own, on subscriptions you already pay for, with no proxy and no markup; work is isolated in git worktrees so parallel agents cannot collide, nothing reaches your tree before a diff, and both are MIT and public — ours whole, platform included.",
        },
        differences: [
            {
                title: "Breadth at the top, or depth underneath",
                body: "Synara's answer to “which agent” is nine, with a session's context following you when you hand it to another. intentic's is five natively plus any ACP agent — and then everything under whichever one you picked: the image, the credentials, the events.",
            },
            {
                title: "The environment is a file you approve",
                body: "Synara wraps the runtimes authenticated on your machine, so what an agent can do is what you have installed. Here the machine is an image, extended by an overlay Dockerfile you read first, and it is per agent rather than per person.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your machine, wrapping your local runtimes" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS, Windows, Linux" },
            {
                label: "Agent runtimes",
                intentic: "5 native harnesses, plus any ACP agent as a capability",
                them: "9: Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok Build, Kilo Code, Pi, Droid",
                theirs: true,
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your machine, as it already is",
            },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "your machine, one login per runtime" },
            { label: "Reach it from elsewhere", intentic: "any browser over a private tunnel, phone included", them: "explicit, self-hosted remote access over your own network" },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "automations and autonomous approval modes" },
            { label: "Sharing with a teammate", intentic: "invite by email; grants enforced by the daemon", them: "single-user, local-first" },
            { label: "Account required", intentic: "a Google sign-in for the hosted workspace", them: "none at all", theirs: true },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "MIT" },
        ],
        pickThem:
            "You want the widest choice of runtime in one window — Antigravity, Kilo Code, Pi and Droid alongside the usual three — on a machine that already carries what your work needs, with no account, no container runtime and no platform in the path.",
        meta: {
            title: "intentic vs Synara · nine runtimes, or a machine each",
            description:
                "Synara runs nine agent runtimes in one local-first, open-source desktop window. intentic runs each agent in a container you configure, with your systems wired in and events that wake it.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "nimbalyst",
        name: "Nimbalyst",
        url: "https://nimbalyst.com/",
        navLabel: "vs Nimbalyst",
        menuBlurb: "Visual artefacts around the agent, or the machine under it",
        family: "orchestrators",
        heading: "Two open-source answers to the same question, built outward in different directions.",
        sub: "Nimbalyst and intentic share more than either shares with anything else here: local, open source, free, parallel worktree sessions, a phone in your pocket, and real teammate collaboration.",
        theirPitch:
            "“The open-source visual workspace for building with Codex, Claude Code, and more.” Markdown, mockups, diagrams, data models and CSVs with visual editors, plus a shared team workspace.",
        verdict: [
            "Nimbalyst builds outward toward the artefacts you and the agent share — markdown, mockups, Excalidraw, CSV, data models — each with a visual editor, and a Teams workspace where teammates' local agents edit the same docs live.",
            "intentic builds outward toward the machine underneath: the image, the credentials, the events that wake it, the tunnel that makes it reachable. Neither is the other's lesser version.",
        ],
        overlap: {
            title: "Where you agree",
            body: "agents run locally on hardware you own, on a subscription you already have, in parallel with git-worktree isolation; both are open source — ours MIT across the whole product, platform included — both answerable from a phone, and both let a teammate in.",
        },
        differences: [
            {
                title: "Visual artefacts, or the machine",
                body: "Nimbalyst's edge is multimodal — WYSIWYG markdown, mockups, diagrams, spreadsheets and data models in one workspace, kept in sync by your agents. intentic's edge is the sandbox under the agent: an overlay-Dockerfile image and capabilities that hand it your systems, so it closes the loop rather than handing you a document.",
            },
            {
                title: "Running when nobody is watching",
                body: "Automations wake an intentic agent on a schedule or an event — a push, an alert, an email, a chat message, a CI result — gated by a guard command you write. Nimbalyst's agents work the shared docs and trackers while you are there.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your machine, in your checkout" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS, Windows, Linux" },
            { label: "On a phone", intentic: "the workspace on your home screen, with push notifications", them: "a native iOS app for managing sessions", theirs: true },
            {
                label: "Visual editors for docs, mockups and diagrams",
                intentic: "a code editor and a diff reader",
                them: "markdown, mockups, Excalidraw, CSV, data models",
                theirs: true,
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your local machine, as it already is",
            },
            { label: "Where credentials live", intentic: "capabilities, kept inside the sandbox", them: "your Claude Code / Codex subscription or your keys" },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "you start it" },
            {
                label: "Team collaboration",
                intentic: "invite by email; teammates share one sandbox, grants daemon-enforced",
                them: "Teams: real-time multiplayer on shared docs (in waitlist)",
            },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "MIT desktop and iOS apps" },
        ],
        pickThem:
            "Your work is as much documents, mockups and diagrams as it is code, you want to review changes visually rather than as a unified diff, and a real-time team canvas where everyone's local agents edit the same docs is the feature you have been waiting for.",
        meta: {
            title: "intentic vs Nimbalyst · two open-source agent workspaces",
            description:
                "Both are local, open source and free, with parallel worktree sessions and real team collaboration. Nimbalyst builds out the visual artefacts; intentic builds out the machine under the agent.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "cursor",
        name: "Cursor",
        url: "https://cursor.com/",
        navLabel: "vs Cursor",
        menuBlurb: "Cloud agents on Cursor's machines, or on yours",
        family: "editors",
        heading: "Cursor grew a fleet of cloud agents. The question is now whose machines they run on.",
        sub: "This used to be editor-versus-agents. It isn't any more: Cursor runs parallel cloud agents on schedules and triggers. What still differs is where they run, what you can change about it, and the bill.",
        theirPitch: "“Cursor is your coding agent for building ambitious software.” A desktop IDE plus cloud agents you can launch in parallel, on schedules and triggers, from your editor, phone or Slack.",
        verdict: [
            "Cursor is an excellent editor that now also runs cloud agents — fleets in parallel, automations on schedules and triggers, review from anywhere. Its agents run in Cursor's own sandboxes, and it is proprietary with paid tiers.",
            "intentic runs the same kind of fleet, but on hardware you own: a container per agent whose image you approve, credentials kept inside it, MIT throughout and free on the subscription you already pay for. Keep Cursor as your editor — desktop sync opens what an agent just wrote.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both run coding agents in parallel with a plan you approve and a diff you review, both reach you from a phone, and both let an agent start itself on a schedule or an event rather than only when you press go.",
        },
        differences: [
            {
                title: "Whose machine the cloud agent runs on",
                body: "Cursor's cloud agents run in Cursor's own sandboxes, testing changes on infrastructure you do not control. An intentic sandbox runs on your laptop, desktop or VPS and dials out over a private tunnel, so the same browser experience never moves your code off a machine you own.",
            },
            {
                title: "Open and free, versus a metered plan",
                body: "Cursor is proprietary and priced in tiers from $20/user, with cloud agents on the paid plans. intentic is MIT end to end and free: it runs on your own model subscription with no proxy, no markup and no per-seat charge for the workspace or for sharing it.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "Cursor's cloud sandboxes, or your local IDE" },
            { label: "The editor", intentic: "a shared editor plus desktop sync to the one you have", them: "a first-class AI IDE — its strongest surface", theirs: true },
            { label: "Model choice", intentic: "5 native harnesses on your own subscriptions, plus any ACP agent", them: "every frontier model, on Cursor's plan", theirs: true },
            { label: "Parallel / cloud agents", intentic: "a fleet of sandboxes, each on your hardware", them: "fleets of cloud agents on Cursor's infrastructure" },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your local machine; the cloud agent's sandbox is theirs",
            },
            { label: "Where credentials live", intentic: "inside a sandbox you own, injected per turn", them: "with Cursor for the cloud agent's run" },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "schedules and triggers from GitHub, Slack, Linear, webhooks" },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "proprietary" },
            { label: "Price", intentic: "free, on your own model subscription", them: "free tier; Pro from $20/user, cloud agents on paid plans" },
        ],
        together: {
            title: "Keep Cursor as your editor",
            body: "Nothing here asks you to give up Cursor. Desktop sync mirrors the sandbox onto your machine, so an agent lands a change and you open it in Cursor — the editor you already know, over the work an agent did on hardware you own.",
        },
        pickThem:
            "You want the best AI editor at your own keyboard with your hands on the code, model choice across every frontier provider matters more than owning the machine, and running cloud agents on Cursor's infrastructure on a paid plan is a trade you are happy to make.",
        meta: {
            title: "intentic vs Cursor · cloud agents, on whose machine",
            description:
                "Cursor now runs parallel cloud agents on its own infrastructure, proprietary and paid. intentic runs the same kind of fleet on hardware you own — a container each, credentials inside, MIT and free — and keeps Cursor as your editor.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "claude-code",
        name: "Claude Code",
        url: "https://www.claude.com/product/claude-code",
        navLabel: "vs Claude Code",
        menuBlurb: "A harness intentic runs — and its own cloud, compared",
        family: "harnesses",
        heading: "intentic runs Claude Code. Its web version runs on Anthropic's machines; intentic's on yours.",
        sub: "Claude Code is one of the five harnesses intentic drives, so this is less either/or than it looks. Where it does compete is its own cloud: Claude Code on the web, which runs on Anthropic-managed VMs.",
        theirPitch:
            "“Work with Claude directly in your codebase. Build, debug, and ship from your terminal, IDE, Slack, web, and more.” On the web, tasks run in isolated, Anthropic-managed cloud VMs.",
        verdict: [
            "Claude Code is a superb terminal-native agent, and it now runs in the cloud too — background sessions on Anthropic-managed VMs, parallel subagents, Routines on a schedule. Its custody model is unusually well documented.",
            "The honest answer is not versus but inside: Claude Code is one of intentic's built-in harnesses, so you run it on a sandbox you own, alongside Codex, Grok, Kimi Code and Google, with capabilities and automations of your own around it.",
        ],
        overlap: {
            title: "Where you agree",
            body: "an agent should read the whole codebase, work to a plan, run in parallel and be answerable from your phone — Claude Code does all of it, and intentic runs Claude Code, so you get that engine either way.",
        },
        differences: [
            {
                title: "Whose machine the cloud runs on",
                body: "Claude Code on the web runs each session in an Anthropic-managed VM, cloning your GitHub repo in; it documents the isolation and credential proxying carefully, and offers a self-hosted-environment option and a local `--teleport`. An intentic sandbox is always a container on hardware you own — the platform holds your identity and a URL, never your code.",
            },
            {
                title: "One harness, or the workshop around it",
                body: "Claude Code is the harness. intentic is the machine and the fleet around a harness: five of them side by side, a container image you approve, capabilities that carry your systems, a board that sorts ten agents by who needs you, and automations that wake them.",
            },
        ],
        table: [
            { label: "What it is", intentic: "the machine and fleet an agent works in", them: "an agentic coding tool — and one intentic runs" },
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your terminal, or Anthropic-managed cloud VMs on the web" },
            {
                label: "Harnesses / models",
                intentic: "Claude Code, Codex, Grok, Kimi Code, Google, plus any ACP agent",
                them: "Claude, on your Claude plan (CLI also supports other providers)",
            },
            { label: "Parallel agents", intentic: "a fleet of sandboxes sorted by who needs you", them: "background sessions and 10s–100s of subagents", theirs: true },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "the cloud VM's setup; on the web it is Anthropic-managed",
            },
            { label: "Where credentials live", intentic: "inside a sandbox you own, injected per turn", them: "a scoped credential proxy; keys kept out of the VM" },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "Routines: schedule, API call, or event; GitHub Actions" },
            { label: "Price", intentic: "free, on your own model subscription", them: "a paid Claude plan from $17–20/mo (Claude Code included)" },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "proprietary product; a Claude subscription or API account" },
        ],
        together: {
            title: "Run Claude Code inside intentic",
            body: "This is the common case, not a compromise: pick Claude Code as an agent's harness in intentic and it runs on a sandbox you own, with your capabilities and automations around it — and you can put Codex or Grok on the next agent over without switching tools.",
        },
        pickThem:
            "You want Anthropic's own polished surfaces end to end — terminal, IDE, desktop, web, mobile — the built-in cloud sessions and Routines fit how you work, and you would rather stay entirely inside one vendor than run a container of your own.",
        meta: {
            title: "intentic vs Claude Code · a harness intentic runs, and its own cloud",
            description:
                "Claude Code is one of intentic's five built-in harnesses, so you run it on a sandbox you own. Its web version runs on Anthropic-managed VMs; intentic runs every harness on your hardware, MIT and free.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "opencode",
        name: "OpenCode",
        url: "https://opencode.ai/",
        navLabel: "vs OpenCode",
        menuBlurb: "An open harness — add it as a capability here",
        family: "harnesses",
        heading: "OpenCode is an open harness. In intentic it is one of the agents you run.",
        sub: "OpenCode is MIT, provider-agnostic and private by design — and it is exactly the kind of agent intentic is built to run. The comparison is really harness versus the machine around a harness.",
        theirPitch: "“The open source AI coding agent.” A terminal, desktop and IDE agent that works with any model from 75+ providers, storing none of your code or context.",
        verdict: [
            "OpenCode is a first-rate open harness: MIT, any model from any provider, local models included, multiple parallel sessions, and it stores none of your code. If you want a lean terminal agent you fully control, it is a great one.",
            "intentic is the layer around a harness rather than a harness itself — a container per agent, capabilities, a fleet board, automations — and OpenCode plugs into it as an ACP agent, so this is add-it-here more than either/or.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both are MIT and readable end to end, both are provider-agnostic and run on the model account you already have, both keep parallel sessions isolated, and neither stores your code on someone else's machine.",
        },
        differences: [
            {
                title: "A harness, or the machine around it",
                body: "OpenCode is the agent loop and its tools, running against your local checkout with your local environment. intentic gives that agent a container built from an image you approve, capabilities that carry your systems, and a board that runs ten at once — OpenCode included, as a capability.",
            },
            {
                title: "Local sessions, or hardware you reach from anywhere",
                body: "OpenCode runs where you launch it and shares a session by link. An intentic sandbox dials a private tunnel out, so the same work is answerable from any browser or a phone, and can run on a VPS you never sit at.",
            },
        ],
        table: [
            { label: "What it is", intentic: "the machine and fleet an agent works in", them: "an open harness — and one intentic can run" },
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your machine — terminal, desktop or IDE" },
            {
                label: "Models",
                intentic: "5 native harnesses on your subscriptions, plus any ACP agent",
                them: "any model from 75+ providers, local models included",
                theirs: true,
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your local machine, as it already is",
            },
            { label: "Systems the agent can reach", intentic: "capabilities: GitHub, Postgres, Sentry, SSH, any MCP server", them: "MCP servers and your local tools" },
            { label: "Reach it from elsewhere", intentic: "any browser over a private tunnel, phone included", them: "runs where you launch it; share a session by link" },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "you start each session" },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "MIT" },
        ],
        together: {
            title: "Add OpenCode as a capability",
            body: "OpenCode speaks ACP, and any ACP agent is a capability in intentic — so you can run OpenCode on a sandbox you own, on the same board as Claude Code and Codex, with your capabilities and automations around it.",
        },
        pickThem:
            "You want a lean, fully open, provider-agnostic terminal agent that stores nothing and runs anywhere, you are happy launching and supervising it yourself, and you do not need a container, a fleet board or events that start it.",
        meta: {
            title: "intentic vs OpenCode · an open harness, and the machine around it",
            description:
                "OpenCode is an MIT, provider-agnostic terminal agent that stores no code. intentic runs harnesses like it on a container you own — capabilities, a fleet board and automations around them — and OpenCode plugs in as an ACP agent.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "openclaw",
        name: "OpenClaw",
        url: "https://openclaw.ai/",
        navLabel: "vs OpenClaw",
        menuBlurb: "An assistant in your chats, or agents on your repos",
        family: "assistants",
        heading: "OpenClaw answers your messages. intentic answers for your repositories.",
        sub: "Both are MIT, both self-hosted, both a tap away on a phone. What differs is where the agent is pointed, and what it leaves behind when it is done.",
        theirPitch:
            "“The AI that really does things.” A self-hosted gateway that meets you in the chat apps you already use — WhatsApp, Telegram, Slack, Discord, Signal, iMessage — with tools, skills and plugins from ClawHub.",
        verdict: [
            "OpenClaw is a personal assistant you host yourself: a gateway on your own devices, reachable from whichever chat app you have open, that clears an inbox, moves a calendar, files a note and turns off a light.",
            "intentic is a workplace for coding agents — a container each, a git worktree each, credentials for your systems, and a diff you read before anything lands. This is a division of labour, and running both is the ordinary outcome.",
        ],
        overlap: {
            title: "Where you agree",
            body: "almost line for line, the same convictions: an agent doing real work belongs on hardware you own, on model accounts that are yours, nothing proxied or marked up; both are MIT and readable end to end, both extend through skills, and both meet you on your phone.",
        },
        differences: [
            {
                title: "The artefact is a diff, not a reply",
                body: "An assistant's output is the message it sends and the change it already made. Here the output is a change on a branch: every agent is cut its own git worktree, and nothing reaches your tree until you have read a diff and landed it.",
            },
            {
                title: "Different systems on the other end",
                body: "OpenClaw's integrations are the ones a life runs on — mail, calendars, notes, music, the house. Capabilities wire an intentic sandbox to the ones work runs on — GitHub, Postgres, Sentry, Stripe, SSH, any MCP server — each with its credential kept inside.",
            },
        ],
        table: [
            {
                label: "What it is for",
                intentic: "software work: a branch, a worktree, a diff",
                them: "the rest of it: mail, calendars, notes, the house",
                theirs: true,
            },
            { label: "Where it runs", intentic: "a Docker sandbox on hardware you own", them: "a gateway on your own devices" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS, Linux, Windows" },
            {
                label: "How you reach it",
                intentic: "any browser over a private tunnel, phone included; Discord and Slack when invited",
                them: "the chat apps you already use — WhatsApp, Telegram, Signal, iMessage and more",
                theirs: true,
            },
            { label: "Reviewing what it did", intentic: "a diff reader you tick through, then land or discard", them: "the reply in the thread, and git afterwards" },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "with the gateway, on the device it runs on" },
            { label: "Runs unattended", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "cron jobs, reminders and background tasks" },
            { label: "Extending it", intentic: "capabilities, extensions and any MCP server", them: "tools, skills and plugins from ClawHub", theirs: true },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "MIT" },
        ],
        together: {
            title: "Hand the repository work over",
            body: "An intentic automation answers a webhook, and an assistant that can call one can start an agent here — so the thing that noticed the failing nightly report can hand the fix to an agent that gets a container, a worktree and a diff. Or invite that agent into the same Discord or Slack the assistant already sits in.",
        },
        pickThem:
            "The job is your life rather than your codebase: an assistant inside the chat app you already have open, clearing mail, moving meetings, filing notes and driving the house — on your own devices, with no account and no container runtime.",
        meta: {
            title: "intentic vs OpenClaw · a personal assistant, and a workplace for agents",
            description:
                "OpenClaw is a self-hosted assistant that lives in your chat apps. intentic is where coding agents work: a container each, a worktree each, a diff before anything lands — and the two compose.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "hermes",
        name: "Hermes",
        url: "https://hermes-agent.nousresearch.com/",
        navLabel: "vs Hermes",
        menuBlurb: "An agent that learns you, or a machine per agent",
        family: "assistants",
        heading: "Hermes gets better at you. intentic gives every agent a machine.",
        sub: "Both are MIT, self-hosted and answerable from a chat app you already have. Hermes spends its effort on what an agent carries between sessions; intentic on what an agent runs inside.",
        theirPitch:
            "“The Agent That Grows With You” — Nous Research's self-improving agent, “the only agent with a built-in learning loop”: it creates skills from experience, improves them in use, and builds a model of you across sessions.",
        verdict: [
            "Hermes is a general-purpose agent with a learning loop: it writes its own skills, remembers across sessions, schedules its own work, and can put its terminal on Docker, SSH or a serverless sandbox. On memory and self-improvement it does something intentic does not attempt.",
            "intentic is narrower on purpose — software work, and everything underneath it: a container built from an image you approve, one worktree per agent, capabilities that carry your systems, and a diff before anything is yours.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both are MIT and self-hosted, both run on model accounts that are yours, both hold that an agent should work on a machine you own, both can put the work in a container, both start on a schedule, and both reach you away from the desk.",
        },
        differences: [
            {
                title: "What is learned, and what is written down",
                body: "The learning loop is Hermes' product: skills generated from experience, memory that outlives a session, a model of you that deepens. intentic's context is authored instead — repo instructions, the skill a capability brings, task lists that survive a rebuild — on the bet that when a coding agent has it wrong you want a file to edit, not a memory to correct.",
            },
            {
                title: "Isolation is the floor, not a backend",
                body: "Hermes lets the terminal choose local, Docker, SSH or a hosted sandbox. Here there is no local option: every agent works inside its container and on a worktree cut for it, and landing replays its delta onto your tree as ordinary git you can amend or revert.",
            },
        ],
        table: [
            {
                label: "What it is",
                intentic: "the machine and workplace an agent works in",
                them: "a general-purpose agent that learns as it goes",
            },
            {
                label: "Memory across sessions",
                intentic: "context you author: repo instructions, skills, task lists that survive a rebuild",
                them: "a learning loop: generated skills, persistent memory, a model of you",
                theirs: true,
            },
            { label: "Where the work runs", intentic: "always a Docker sandbox on hardware you own", them: "local, Docker, SSH or a serverless sandbox, as configured" },
            { label: "Isolation", intentic: "one container and one git worktree per agent", them: "isolated subagents inside a conversation" },
            {
                label: "How you reach it",
                intentic: "any browser over a private tunnel, phone included; Discord and Slack when invited",
                them: "a CLI plus Telegram, Discord, Slack, WhatsApp, Signal and 20+ more",
                theirs: true,
            },
            {
                label: "Which models",
                intentic: "5 native harnesses on subscriptions you already pay for, plus any ACP agent",
                them: "any endpoint — Nous Portal, OpenRouter, OpenAI or your own",
                theirs: true,
            },
            { label: "Reviewing changes", intentic: "a diff reader over an isolated worktree, then land or discard", them: "git, in the terminal it ran in" },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "a natural-language cron scheduler" },
            { label: "Licence", intentic: "MIT throughout — sandbox, platform and CLI", them: "MIT" },
        ],
        together: {
            title: "One machine, two jobs",
            body: "Both run on hardware you own, and an intentic automation answers a webhook — so Hermes can hand the repository work down to an agent that gets a container, a worktree and a diff, then report back in whichever chat you asked from.",
        },
        pickThem:
            "You want one agent that keeps getting better at you — writing its own skills, remembering how it solved something last month, reachable in whatever chat app you happen to be in — and your work is much broader than repositories.",
        meta: {
            title: "intentic vs Hermes · a self-improving assistant, and a sandbox per agent",
            description:
                "Hermes is Nous Research's self-improving agent: MIT, self-hosted, with generated skills and memory. intentic runs coding agents in a container and a git worktree each, with a diff before anything lands.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "cloud-agents",
        name: "cloud agent platforms",
        url: "https://devin.ai/",
        navLabel: "vs cloud agents",
        menuBlurb: "Devin, Jules, Codex cloud: the one real either/or",
        family: "cloud",
        heading: "The only comparison on this page that is actually a choice.",
        sub: "Devin, Google Jules, OpenAI Codex cloud, Claude Code on the web, Replit Agent. Everything else here composes with intentic. These do not, because they answer one question differently: whose computer holds your source.",
        theirPitch:
            "A hosted agent you give a task and a repository to. It clones your repo into the vendor's cloud VM, works there, and hands you a pull request.",
        verdict: [
            "The experience is genuinely good and the setup cost is genuinely zero: connect a repo and go. That is the trade — your code, your keys and your production access live in the vendor's sandbox for the duration of the run.",
            "intentic's position is that the browser experience was never the part that required giving that up. The sandbox runs on hardware you own and the platform sits off the command path — and every line of both is MIT in one public repo, so it is a claim you can check.",
        ],
        overlap: {
            title: "Where you agree",
            body: "an agent should be supervised from a browser, not a terminal; it should run several jobs in parallel, show its plan before it acts and its diff before anything lands — every one of those is a cloud-agent idea and intentic took all of them.",
        },
        differences: [
            {
                title: "Custody, stated architecturally",
                body: "These platforms clone your repository into a vendor-managed VM to run — Jules and Claude Code call it a Cloud VM, Codex “isolated cloud environments,” Devin sells Devin Cloud. Your browser holds the token that commands an intentic sandbox; the platform stores identity, a URL and grants, and never your code, prompts or capability credentials.",
            },
            {
                title: "Your subscription and hardware, no meter",
                body: "Cloud platforms bill for the model and the machine, usually with a markup, from roughly $20 to $200 a month. intentic runs on the account you already pay for, on hardware you already own, and charges nothing — the trade is that you provide the machine and cannot burst past it.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "your hardware", them: "the vendor's cloud VM" },
            { label: "Who can read your source", intentic: "you; the platform has no path to it", them: "the vendor, for the duration of the run" },
            { label: "How it gets your code", intentic: "it is already on your machine", them: "cloned from GitHub, or uploaded, into their VM" },
            { label: "Where your service credentials sit", intentic: "inside your sandbox", them: "in the vendor's secret store" },
            { label: "Model billing", intentic: "your own subscription, never metered by us", them: "the vendor's plan, usually with a markup" },
            { label: "Compute billing", intentic: "hardware you already own", them: "the vendor's, metered or bundled" },
            { label: "Supervision", intentic: "fleet board, plan mode, diff review, transcripts", them: "plan, diff and PR review, from the browser" },
            { label: "Setup", intentic: "Docker, a Google account, one pasted command", them: "connect a repo; nothing to host", theirs: true },
            { label: "Elastic capacity", intentic: "bounded by the machine you provide", them: "as many parallel agents as you will pay for", theirs: true },
            {
                label: "Enterprise paperwork",
                intentic: "no certifications yet; the whole system is MIT and auditable",
                them: "established vendors with SOC 2, SSO and the certifications",
                theirs: true,
            },
        ],
        pickThem:
            "You would rather not provide a machine, the repository is not especially sensitive, your procurement needs a vendor with the certifications already in hand, and you want to burst to fifty parallel agents on a Tuesday without owning fifty cores.",
        meta: {
            title: "intentic vs Devin, Jules and cloud agents · whose machine runs it",
            description:
                "Cloud agent platforms clone your repo into the vendor's VM to run — Devin, Jules, Codex cloud, Claude Code on the web, Replit. intentic keeps the same browser experience with the sandbox on hardware you own, free and MIT.",
            datePublished: PUBLISHED,
        },
    },
];

export const comparePage = (slug: string): ComparePage | undefined => comparePages.find((page) => page.slug === slug);

export const familyPages = (id: string): ComparePage[] => comparePages.filter((page) => page.family === id);

/* The hub's own copy. It leads with the taxonomy rather than with us, because the reader's question is
 * "which of these things are you" and answering it first is what makes the rest credible. The two axes are
 * the ones that survived the field converging on parallel and cloud agents. */
export const compareIndex = {
    eyebrow: "Compare",
    heading: "Most of these are not competitors.",
    sub: "“How does this compare to X?” is the question we get most. For four out of five values of X, the honest answer is that X is something intentic runs or something you keep alongside it.",
    axes: {
        heading: "Two questions sort the entire field",
        items: [
            {
                title: "Whose machine does the agent run on?",
                body: "Yours, or a vendor's. It decides who can read your source, where your service credentials sit, and what a breach at the vendor is worth. The rest of the field has agents now too — this is the line nobody can be on both sides of.",
            },
            {
                title: "How much of the agent's environment can you change?",
                body: "Everywhere else the prompt is the layer you get. The layers under it — the image, the systems, the context — are what decide whether it can finish a job.",
            },
        ],
    },
    correction: {
        title: "Found something out of date?",
        body: "These describe other people's products and they ship as fast as we do. Every claim was re-checked against the vendor's own site on the date each page shows; where we have it wrong, open an issue.",
        cta: "Report an inaccuracy",
    },
    meta: {
        title: "How intentic compares · Cursor, Claude Code, Conductor, Superset, Devin",
        description:
            "Where intentic sits among agent CLIs, AI editors, personal assistants, local orchestrators and cloud platforms — Cursor, Claude Code, Conductor, Superset, Synara, Devin — with the honest case for each.",
        datePublished: PUBLISHED,
    },
};
