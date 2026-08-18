/* The comparison shelf: "how does intentic compare to X?", answered honestly and once per X.
 *
 * A feature matrix where every row is a tick for us is the fastest way to lose the
 * credibility the rest of the site is built on. So the shelf is organised around a fact that is true and
 * disarming: MOST of the tools people name are not competitors. The agent CLIs are harnesses this product
 * runs; the editors keep working through desktop sync; the assistants do a different job on the same
 * hardware; the local orchestrators share the instinct and intentic goes a layer deeper; only the cloud
 * platforms are a real either/or.
 *
 * Since these first shipped the field has CONVERGED: Cursor, Claude Code, Conductor and others grew their
 * own cloud or background agents, so "we have agents and they don't" is no longer true anywhere. What stays
 * true is the pair of axes the hub is built on: whose machine the agent runs on, and how much of its
 * environment you can change. Every page is written to those.
 *
 * Accuracy rules, because these describe other people's products and those products move weekly:
 * - Quote their own words for what they are (`theirPitch`), and link `url` so a reader can check.
 * - Every fact was re-verified against the vendor's own live site on the datePublished below.
 * - No invented numbers; where a vendor does not state something (a licence, a price), the page does not either.
 * - Every table carries rows that go the other way (`theirs`). A table with no losing rows is one nobody believes.
 * - `sources` names the vendor's OWN documentation, and every entry was opened rather than guessed at from a
 *   naming pattern. A row describing their isolation, automation or review behaviour has to be readable in one
 *   of them, or the row does not exist: a comparison page is the easiest page on any site to quietly fabricate.
 */

export const compareHref = (slug: string): string => (slug ? `/compare/${slug}/` : `/compare/`);

// Re-verified against every vendor's live site on this date. These products ship fast; this is a snapshot.
const PUBLISHED = "2026-08-09";

/* When the cited documentation was last opened and read. Separate from PUBLISHED because the two decay at
 * different rates and a reader deserves both: PUBLISHED is when the argument was written, this is when the
 * evidence under it was last checked. Bump it only after actually re-reading every `sources` entry. */
const VERIFIED = "2026-08-18";

/** One kind of tool people confuse this product with: the unit the hub is organised in. */
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
    /** Their site: every claim on the page has to be checkable there. */
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
    /** Where the two overlap. Written generously: it earns the right to the contrast. */
    overlap: CompareSection;
    /** The one or two distinctions that survive the table. Kept short; the table carries the detail. */
    differences: CompareSection[];
    table: CompareRow[];
    /** Present where the honest answer is "run both", with the mechanism that makes it true. */
    together?: CompareSection;
    /** The case for them. A real recommendation, not a strawman. */
    pickThem: string;
    /* THE VENDOR'S OWN PAGES, NAMED. `url` is their front door, which is marketing; these are the documents a
     * reader checks a claim against, and every one of them was opened rather than guessed at. A comparison
     * that cites nothing is asking to be taken on faith, which is the one thing this shelf refuses to do
     * anywhere else. It is also what stops the page going quietly stale: a dead link is a visible failure. */
    sources: { label: string; url: string }[];
    meta: { title: string; description: string; datePublished: string };
}

export const compareFamilies: CompareFamily[] = [
    {
        id: "harnesses",
        label: "Agent CLIs",
        verdict: "intentic runs these",
        body: "A harness turns a model into an agent in your terminal: the loop, the tools, the permission prompts. intentic provides the machine around it, with five built in and any ACP agent supported. Where a harness offers cloud sessions too, the difference is whose machine runs them.",
        examples: ["Claude Code", "Codex", "Grok", "Kimi Code", "Gemini CLI", "OpenCode", "Goose", "Qwen Code"],
    },
    {
        id: "editors",
        label: "AI editors",
        verdict: "keep yours",
        body: "An AI editor keeps you at the keyboard. With intentic the agent writes and you review, and desktop sync mirrors the sandbox so your editor opens its latest work. Editors offer cloud agents now too; the difference is whose infrastructure runs them.",
        examples: ["Cursor", "Windsurf", "VS Code + Copilot", "Zed", "JetBrains AI"],
    },
    {
        id: "assistants",
        label: "Personal AI assistants",
        verdict: "a different job",
        body: "An assistant lives in your chat apps and handles your inbox, calendar, notes and home. intentic focuses on work that ends in a code diff, and an assistant that can call a webhook can start an agent here.",
        examples: ["OpenClaw", "Hermes", "Khoj", "Leon"],
    },
    {
        id: "orchestrators",
        label: "Local agent orchestrators",
        verdict: "same instinct, wider scope",
        body: "Local orchestrators run several agents at once, each in its own worktree. intentic also manages the image, credentials, events and teammate access around each one, and stays free and MIT while several alternatives charge per seat.",
        examples: ["Conductor", "Superset", "T3 Code", "Synara", "Nimbalyst", "Crystal", "Vibe Kanban", "Sculptor"],
    },
    {
        id: "cloud",
        label: "Cloud agent platforms",
        verdict: "the opposite trade",
        body: "The only genuine either/or here. They run the agent on their infrastructure, so your source and keys are cloned into their sandbox for the run. intentic gives the same browser experience on your own machine.",
        examples: ["Devin", "Google Jules", "Codex cloud", "Claude Code on the web", "Replit Agent", "Cursor cloud agents"],
    },
];

export const comparePages: ComparePage[] = [
    {
        slug: "conductor",
        name: "Conductor",
        url: "https://conductor.build/",
        navLabel: "vs Conductor",
        menuBlurb: "Parallel agents on a Mac versus a configurable machine per agent",
        family: "orchestrators",
        heading: "Both run parallel agents. Only one hands each a machine it configures.",
        sub: "Both run several agents at once, each on its own branch. They differ in what sits under the agent, and what it costs.",
        theirPitch: "“Run parallel Claude Code, Codex, and Cursor agents in isolated workspaces on your Mac.”",
        verdict: [
            "A polished native Mac app for running many agents in parallel, now with Conductor Cloud to offload them. If your agents only need what is already on that Mac, it does the job well.",
            "intentic gives each agent a container with an image you approve and credentials kept inside. All of it is free and MIT.",
        ],
        overlap: {
            title: "Where you agree",
            body: "agents run in parallel, each on its own branch and your own model subscription, with nothing merged until you have read the diff.",
        },
        differences: [
            {
                title: "A container, not your Mac as it is",
                body: "Conductor runs agents in your existing environment, so an agent's reach is whatever you happen to have installed. Each intentic agent gets an image you approve, plus capabilities handing it GitHub, Postgres or any MCP server with the credential kept inside.",
            },
            {
                title: "Free and MIT, not a seat you rent",
                body: "Conductor is free to start, but cloud, multiplayer and teams sit behind $50–60/seat plans, and its source is not published. All of intentic is MIT and free, sharing included.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your Mac, or Conductor Cloud on a paid plan" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS" },
            {
                label: "Reach it from elsewhere",
                intentic: "any browser over a private tunnel, phone included",
                them: "the Mac, or Conductor Cloud (mobile app coming)",
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your local machine, as it already is",
            },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "your local shell" },
            {
                label: "Runs without you at the keyboard",
                intentic: "automations on cron, webhook, push, alert, email, chat",
                them: "background tasks in early access; you start each session",
            },
            { label: "Isolation", intentic: "one git worktree per agent", them: "one workspace and branch per task" },
            {
                label: "Price",
                intentic: "free, including the sandbox, platform and sharing",
                them: "free tier; cloud, multiplayer and teams from $50–60/seat",
            },
            {
                label: "A machine you do not have to provide",
                intentic: "you bring the hardware",
                them: "Conductor Cloud, nothing to host",
                theirs: true,
            },
            {
                label: "Native desktop app",
                intentic: "native on Windows and Linux, browser elsewhere, plus desktop sync",
                them: "a refined native macOS app",
                theirs: true,
            },
            { label: "Source you can read", intentic: "all of it, MIT on GitHub with the platform included", them: "not published" },
            {
                label: "Review workflow",
                intentic: "the diff in the Changes panel, approved before it lands",
                them: "review the diff, open a pull request, merge, archive the workspace",
            },
        ],
        pickThem:
            "You work on one Mac, want a native app over a browser, your agents only need what is already installed, and you would rather click Conductor Cloud than provide a machine.",
        sources: [
            { label: "Docs", url: "https://www.conductor.build/docs" },
            { label: "Pricing", url: "https://www.conductor.build/pricing" },
        ],
        meta: {
            title: "intentic vs Conductor · parallel agents, compared",
            description:
                "Both run parallel coding agents, each on its own branch. intentic adds sandbox images, capabilities, automations and browser access, free and MIT.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "superset",
        name: "Superset",
        url: "https://superset.sh/",
        navLabel: "vs Superset",
        menuBlurb: "A similar feature list without the machine underneath",
        family: "orchestrators",
        heading: "The nearest neighbour on this page. The difference sits a layer below the feature list.",
        sub: "Superset runs 100+ parallel agents, each in its own git worktree, with diffs, terminals, cron automations and an MCP server. What it does not hand an agent is a machine of its own.",
        theirPitch:
            "“Run 100+ parallel coding agents on your machine.” Superset is a source-available desktop app under the Elastic License 2.0. It runs any CLI agent in its own isolated Git worktree.",
        verdict: [
            "Feature for feature the closest tool here, and the overlap is real: worktree isolation, scheduled runs, a diff between agent and tree, direct model keys.",
            "Superset's agents run in your local environment. Each intentic agent gets a container from an image you approve, credentials kept inside. intentic is MIT and free; Superset is source-available under ELv2 with a paid Pro tier.",
        ],
        overlap: {
            title: "Where you agree",
            body: "agents run in parallel, each in its own git worktree, on the subscription you already pay for. Neither proxies or marks up model calls, and both put a diff between the agent and your tree.",
        },
        differences: [
            {
                title: "A container, not the Mac as you left it",
                body: "Superset shapes a workspace with setup scripts, using the tools already on your machine. In intentic a Dockerfile defines the machine and needs your approval, so an agent can have psql and a headless browser without adding them to your laptop.",
            },
            {
                title: "Credentials the agent operates",
                body: "Capabilities connect a sandbox to GitHub, PostgreSQL, Sentry, Discord, SSH or any MCP server, each secret injected per turn and never leaving. Superset connects GitHub and Linear, and otherwise uses the keys already in your environment.",
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
            {
                label: "Where credentials live",
                intentic: "capabilities, kept inside the sandbox",
                them: "your environment; GitHub and Linear app connectors",
            },
            {
                label: "Runs without you at the keyboard",
                intentic: "cron, webhook, push, alert, email, chat, CI/CD, workspace events",
                them: "cron-like scheduled runs",
            },
            {
                label: "Reach it from elsewhere",
                intentic: "any browser over a private tunnel, phone included",
                them: "remote workspaces on Pro; mobile coming",
            },
            { label: "Licence", intentic: "MIT for the sandbox, platform and CLI", them: "source-available (Elastic License 2.0)" },
            { label: "Price", intentic: "free, everything included", them: "free tier; Pro from $15–20/user, remote on Pro", theirs: true },
            { label: "Isolation", intentic: "a container and a git worktree per agent", them: "an isolated branch per parallel session" },
            {
                label: "Review workflow",
                intentic: "the diff in the Changes panel, approved before it lands",
                them: "a built-in diff viewer: stage, commit, push, open a PR",
            },
        ],
        pickThem:
            "You are on a Mac, want parallel agents in the triple digits today, need only the toolchain that Mac carries, and prefer a low per-seat Pro tier to a container you configure.",
        sources: [
            { label: "Docs", url: "https://docs.superset.sh/" },
            { label: "Pricing", url: "https://superset.sh/pricing" },
        ],
        meta: {
            title: "intentic vs Superset · parallel agents, and the machine under them",
            description:
                "Superset runs 100+ parallel CLI agents in git worktrees on your Mac (ELv2, paid Pro). intentic gives each agent a container you configure, free and MIT.",
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
        sub: "Both share your subscription, an MIT licence and strong phone support. The difference is the layer under the agent.",
        theirPitch:
            "“The open-source control plane for coding agents.” T3 Code runs Claude Code, Codex, OpenCode, Cursor and Grok from one surface across desktop, web and native iOS and Android. Bring your own subscription or fork the whole product.",
        verdict: [
            "T3 Code drives the harnesses installed on one computer, from desktop, web and first-class iOS and Android apps. It is MIT, free, and asks for nothing you are not already paying for.",
            "intentic changes what an agent inherits: not your machine as it stands, but a container from an image you approve, capabilities that hand it your systems, and events that start it while you sleep.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both use your existing subscription, with no resale or metering. You can switch harnesses mid-thread, read the MIT source, and answer from your phone a run you started at your desk.",
        },
        differences: [
            {
                title: "What the agent inherits",
                body: "T3 Code launches the CLIs on the computer running its server, so an agent's reach is your reach: your PATH, your logins, your clients. In intentic the machine is an image you approve, so two agents on one host can carry entirely different toolchains.",
            },
            {
                title: "Systems, and running unwatched",
                body: "Capabilities connect a sandbox to GitHub, Postgres, Sentry, Stripe, SSH and MCP servers, each credential kept inside, and automations start a fresh session on a schedule or event. T3 Code runs the threads you open, where you opened them.",
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
            {
                label: "On a phone",
                intentic: "the workspace on your home screen, with push notifications",
                them: "native iOS and Android apps",
                theirs: true,
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your machine, as it already is",
            },
            { label: "Where credentials live", intentic: "inside the sandbox, injected per turn", them: "your shell, one login per harness" },
            { label: "Isolation", intentic: "one git worktree per agent", them: "a branch per agent thread" },
            {
                label: "Starts on an event",
                intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events",
                them: "you start each thread",
            },
            { label: "Licence", intentic: "MIT for the sandbox, platform and CLI", them: "MIT throughout" },
        ],
        pickThem:
            "Your computer already has every tool and login your agents need, and native iOS and Android apps matter more than a browser tab. It is one MIT app with nothing to configure.",
        sources: [{ label: "Source and README", url: "https://github.com/pingdotgg/t3code" }],
        meta: {
            title: "intentic vs T3 Code · a control plane, or the machine under it",
            description:
                "T3 Code drives harnesses on your computer from desktop, web and mobile, MIT and free. intentic gives each agent a container you approve, woken by events.",
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
        sub: "Both are free, local-first and open source, both isolate work in git worktrees, and neither goes near your tokens. They spend their effort at opposite ends of the same stack.",
        theirPitch:
            "“Run every coding agent in one workspace.” Synara is a free, open-source, local-first desktop workspace and control plane for provider runtimes already configured on your machine.",
        verdict: [
            "Synara supports nine runtimes: Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok Build, Kilo Code, Pi and Factory Droid, with split chats, terminals, previews, worktrees and a one-action PR.",
            "intentic invests in depth underneath: whichever harness you pick gets a container you approve, capabilities that hand it your repo, database and error tracker, and an event that starts it without you.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both run on subscriptions you already pay for, with no proxy or markup. Git worktrees keep parallel agents apart and a diff protects your main tree. Both are MIT; intentic includes its platform source too.",
        },
        differences: [
            {
                title: "Breadth at the top, or depth underneath",
                body: "Synara supports nine agents and keeps context when you hand a session to another. intentic supports five natively plus any ACP agent, and controls the image, credentials and events around it.",
            },
            {
                title: "The environment is a file you approve",
                body: "Synara wraps the runtimes on your machine, so what an agent can do is what you have installed. Here the machine is an image you read first, and it is per agent rather than per person.",
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
            {
                label: "Reach it from elsewhere",
                intentic: "any browser over a private tunnel, phone included",
                them: "explicit, self-hosted remote access over your own network",
            },
            {
                label: "Starts on an event",
                intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events",
                them: "automations and autonomous approval modes",
            },
            { label: "Sharing with a teammate", intentic: "invite by email; grants enforced by the daemon", them: "single-user, local-first" },
            { label: "Account required", intentic: "a Google sign-in for the hosted workspace", them: "none at all", theirs: true },
            { label: "Licence", intentic: "MIT for the sandbox, platform and CLI", them: "MIT" },
            {
                label: "Isolation",
                intentic: "a container and a git worktree per agent",
                them: "the local checkout, or linked git worktrees per task",
            },
            {
                label: "Runs without you at the keyboard",
                intentic: "automations on cron, webhook, push, alert, email, chat",
                them: "automations in the desktop app",
            },
            {
                label: "Review workflow",
                intentic: "the diff in the Changes panel, approved before it lands",
                them: "inspect the diff, verify, commit, push, open a pull request",
            },
        ],
        pickThem:
            "You want the widest runtime choice in one window, your machine already has what the agents need, and you want no account, container runtime or platform in the path.",
        sources: [{ label: "Docs", url: "https://www.trysynara.com/docs" }],
        meta: {
            title: "intentic vs Synara · nine runtimes, or a machine each",
            description:
                "Synara runs nine agent runtimes in one local-first, open-source window. intentic runs each agent in a container you configure and wire to your systems.",
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
        sub: "Both are local, open source and free, with parallel worktree sessions, phone access and teammates.",
        theirPitch:
            "“The open-source visual workspace for building with Codex, Claude Code, and more.” Markdown, mockups, diagrams, data models and CSVs with visual editors, plus a shared team workspace.",
        verdict: [
            "Nimbalyst focuses on the artefacts you share with an agent: markdown, mockups, Excalidraw, CSV and data models, each with a visual editor, and a Teams workspace where local agents edit the same documents live.",
            "intentic builds toward the machine underneath: the image, the credentials, the events that wake it. Neither is the other's lesser version.",
        ],
        overlap: {
            title: "Where you agree",
            body: "agents run locally on a subscription you already have, with git worktrees keeping parallel work apart. Both are open source, work from a phone and support teammates. intentic is MIT across the full product.",
        },
        differences: [
            {
                title: "Visual artefacts, or the machine",
                body: "Nimbalyst puts markdown, mockups, diagrams, spreadsheets and data models in one workspace that agents keep in sync. intentic focuses on the sandbox under the agent: an image you approve, and capabilities that connect it to your systems.",
            },
            {
                title: "Running when nobody is watching",
                body: "Automations start an intentic agent from a push, alert, email, chat, CI result or schedule. An optional command you write can skip a run. Nimbalyst's agents work on shared documents while you are there.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your machine, in your checkout" },
            { label: "Host operating system", intentic: "macOS, Linux, Windows", them: "macOS, Windows, Linux" },
            {
                label: "On a phone",
                intentic: "the workspace on your home screen, with push notifications",
                them: "a native iOS app for managing sessions",
                theirs: true,
            },
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
            {
                label: "Where credentials live",
                intentic: "capabilities, kept inside the sandbox",
                them: "your Claude Code / Codex subscription or your keys",
            },
            { label: "Starts on an event", intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events", them: "you start it" },
            {
                label: "Team collaboration",
                intentic: "invite by email; teammates share one sandbox, grants daemon-enforced",
                them: "Teams: real-time multiplayer on shared docs (in waitlist)",
            },
            { label: "Licence", intentic: "MIT for the sandbox, platform and CLI", them: "MIT desktop and iOS apps" },
            {
                label: "Review workflow",
                intentic: "the diff in the Changes panel, approved before it lands",
                them: "every AI edit surfaced as a diff to approve before it lands",
            },
        ],
        pickThem:
            "Documents, mockups and diagrams matter as much as code, and visual review suits you better than a unified diff. Its team canvas lets everyone's local agents edit the same documents.",
        sources: [
            { label: "Docs", url: "https://nimbalyst.com/docs" },
            { label: "Pricing", url: "https://nimbalyst.com/pricing/" },
        ],
        meta: {
            title: "intentic vs Nimbalyst · two open-source agent workspaces",
            description:
                "Both are local, open source and free, with parallel worktree sessions and team collaboration. Nimbalyst builds the artefacts; intentic builds the machine.",
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
        sub: "This used to be editor versus agents. Not any more: Cursor runs parallel cloud agents too. What differs is where they run, what you can change, and the bill.",
        theirPitch:
            "“Cursor is your coding agent for building ambitious software.” A desktop IDE plus cloud agents you can launch in parallel, on schedules and triggers, from your editor, phone or Slack.",
        verdict: [
            "An excellent editor that now also runs parallel cloud agents, scheduled automations and triggered runs. Its agents run in Cursor's own sandboxes, and the product is proprietary with paid tiers.",
            "intentic runs the same kind of fleet on your own machine: a container you approve, credentials kept inside, free and MIT, on the subscription you already pay for. Keep Cursor as your editor; desktop sync opens the agent's latest work there.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both run agents in parallel with a plan you approve and a diff you review, both reach you on a phone, and both let an agent start itself on a schedule or event.",
        },
        differences: [
            {
                title: "Whose machine the cloud agent runs on",
                body: "Cursor's cloud agents run in Cursor's own sandboxes, on infrastructure you do not control. An intentic sandbox runs on your laptop, desktop or VPS and dials out over a private tunnel, so the same browser experience never moves your code.",
            },
            {
                title: "Open and free, versus a metered plan",
                body: "Cursor is proprietary, from $20/user, with cloud agents on paid plans. intentic is MIT end to end and free, on your own subscription, with no proxy, markup or per-seat charge.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "Cursor's cloud sandboxes, or your local IDE" },
            {
                label: "The editor",
                intentic: "a shared editor plus desktop sync to the one you have",
                them: "a first-class AI IDE and its strongest surface",
                theirs: true,
            },
            {
                label: "Model choice",
                intentic: "5 native harnesses on your own subscriptions, plus any ACP agent",
                them: "every frontier model, on Cursor's plan",
                theirs: true,
            },
            {
                label: "Parallel / cloud agents",
                intentic: "a fleet of sandboxes, each on your hardware",
                them: "fleets of cloud agents on Cursor's infrastructure",
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "your local machine; the cloud agent's sandbox is theirs",
            },
            {
                label: "Where credentials live",
                intentic: "inside a sandbox you own, injected per turn",
                them: "with Cursor for the cloud agent's run",
            },
            {
                label: "Starts on an event",
                intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events",
                them: "schedules and triggers from GitHub, Slack, Linear, webhooks",
            },
            { label: "Licence", intentic: "MIT for the sandbox, platform and CLI", them: "proprietary" },
            { label: "Price", intentic: "free, on your own model subscription", them: "free tier; Pro from $20/user, cloud agents on paid plans" },
            {
                label: "Isolation",
                intentic: "a container and a git worktree per agent, on your machine",
                them: "a Cursor-managed VM per cloud agent; the local agent edits your tree",
            },
            {
                label: "Review workflow",
                intentic: "the diff in the Changes panel, approved before it lands",
                them: "checkpoints you can restore, and pull requests from cloud agents",
            },
        ],
        together: {
            title: "Keep Cursor as your editor",
            body: "Nothing here asks you to give up Cursor. Desktop sync mirrors the sandbox onto your machine, so an agent lands a change and you open it in the editor you already know.",
        },
        pickThem:
            "You want the best AI editor under your own hands, model choice across every frontier provider matters more than the machine, and running cloud agents on Cursor's infrastructure is a trade you are happy to make.",
        sources: [
            { label: "Cloud agents", url: "https://cursor.com/docs/cloud-agent" },
            { label: "Pricing", url: "https://cursor.com/pricing" },
        ],
        meta: {
            title: "intentic vs Cursor · cloud agents, on whose machine",
            description:
                "Cursor runs parallel cloud agents on its own paid infrastructure. intentic runs the same fleet on your machine, free and MIT. Keep Cursor as your editor.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "claude-code",
        name: "Claude Code",
        url: "https://www.claude.com/product/claude-code",
        navLabel: "vs Claude Code",
        menuBlurb: "A harness intentic runs, plus its own cloud",
        family: "harnesses",
        heading: "intentic runs Claude Code. Its web version runs on Anthropic's machines; intentic's on yours.",
        sub: "Claude Code is one of the five harnesses intentic drives, so this is less either/or than it looks. Where it competes is its own cloud, which runs on Anthropic-managed VMs.",
        theirPitch:
            "“Work with Claude directly in your codebase. Build, debug, and ship from your terminal, IDE, Slack, web, and more.” On the web, tasks run in isolated, Anthropic-managed cloud VMs.",
        verdict: [
            "A strong terminal-native agent that also runs in the cloud, with background sessions on Anthropic-managed VMs, parallel subagents and scheduled Routines. Its custody model is well documented.",
            "It is also one of intentic's built-in harnesses: run it beside Codex, Grok, Kimi Code and Google, with your own capabilities and automations around it.",
        ],
        overlap: {
            title: "Where you agree",
            body: "Claude Code reads the whole codebase, works to a plan, runs in parallel and takes replies from your phone. intentic runs it, so the same agent is available either way.",
        },
        differences: [
            {
                title: "Whose machine the cloud runs on",
                body: "Claude Code on the web runs each session in an Anthropic-managed VM and clones your repo into it. Anthropic documents the isolation and offers a self-hosted option. An intentic sandbox is a container on a machine you choose: yours by default, with the platform holding only your identity and a URL, or a free starter box we run for you if you would rather not host one — the difference being that moving off ours is a lane switch rather than a migration.",
            },
            {
                title: "One harness, or the workshop around it",
                body: "Claude Code is the harness. intentic is the machine and fleet around one: five side by side, an image you approve, capabilities that carry your systems, a board that sorts ten agents, and automations that wake them.",
            },
        ],
        table: [
            { label: "What it is", intentic: "the machine and fleet an agent works in", them: "an agentic coding tool that intentic can run" },
            {
                label: "Where the agent runs",
                intentic: "a Docker sandbox on hardware you own",
                them: "your terminal, or Anthropic-managed cloud VMs on the web",
            },
            {
                label: "Harnesses / models",
                intentic: "Claude Code, Codex, Grok, Kimi Code, Google, plus any ACP agent",
                them: "Claude, on your Claude plan (CLI also supports other providers)",
            },
            {
                label: "Parallel agents",
                intentic: "a fleet of sandboxes sorted by who needs you",
                them: "background sessions and 10s–100s of subagents",
                theirs: true,
            },
            {
                label: "What you can change about the environment",
                intentic: "the image, the capabilities, the context loaded each turn",
                them: "the cloud VM's setup; on the web it is Anthropic-managed",
            },
            {
                label: "Where credentials live",
                intentic: "inside a sandbox you own, injected per turn",
                them: "a scoped credential proxy; keys kept out of the VM",
            },
            {
                label: "Starts on an event",
                intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events",
                them: "Routines: schedule, API call, or event; GitHub Actions",
            },
            { label: "Price", intentic: "free, on your own model subscription", them: "a paid Claude plan from $17–20/mo (Claude Code included)" },
            {
                label: "Licence",
                intentic: "MIT for the sandbox, platform and CLI",
                them: "proprietary product; a Claude subscription or API account",
            },
            {
                label: "Runs without you at the keyboard",
                intentic: "automations on cron, webhook, push, alert, email, chat",
                them: "recurring tasks scheduled from the desktop app",
            },
            {
                label: "Review workflow",
                intentic: "the diff in the Changes panel, approved before it lands",
                them: "diffs in the IDE extensions; commits and pull requests from the CLI",
            },
        ],
        together: {
            title: "Run Claude Code inside intentic",
            body: "Pick Claude Code as an agent's harness in intentic and it runs on a sandbox you own, with your capabilities and automations around it. The next agent can use Codex or Grok without switching tools.",
        },
        pickThem:
            "You want Anthropic's terminal, IDE, desktop, web and mobile surfaces, its cloud sessions and Routines fit your work, and you prefer one vendor to running your own container.",
        sources: [
            { label: "Docs", url: "https://code.claude.com/docs/en/overview" },
            { label: "Pricing", url: "https://claude.com/pricing" },
        ],
        meta: {
            title: "intentic vs Claude Code · a harness intentic runs, and its own cloud",
            description:
                "Claude Code is one of intentic's five built-in harnesses. Its web version runs on Anthropic-managed VMs; intentic runs every harness on your machine.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "opencode",
        name: "OpenCode",
        url: "https://opencode.ai/",
        navLabel: "vs OpenCode",
        menuBlurb: "An open harness you can add as a capability",
        family: "harnesses",
        heading: "OpenCode is an open harness. In intentic it is one of the agents you run.",
        sub: "OpenCode is MIT, provider-agnostic and private by design. intentic can run it, so this compares a harness with the machine around one.",
        theirPitch:
            "“The open source AI coding agent.” A terminal, desktop and IDE agent that works with any model from 75+ providers, storing none of your code or context.",
        verdict: [
            "An MIT harness that works with any provider, local models included. It runs parallel sessions, stores none of your code, and fits teams wanting a lean terminal agent.",
            "intentic adds a container, capabilities, a fleet board and automations around a harness. OpenCode plugs in as an ACP agent, so you can use both.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both are MIT and readable end to end, both run on the model account you already have, both keep parallel sessions isolated, and neither stores your code elsewhere.",
        },
        differences: [
            {
                title: "A harness, or the machine around it",
                body: "OpenCode is the agent loop and tools, running against your local checkout. intentic gives it a container you approve, connections to your systems and a board for ten agents at once.",
            },
            {
                title: "Local sessions, or hardware you reach from anywhere",
                body: "OpenCode runs where you launch it and shares a session by link. An intentic sandbox dials out over a private tunnel, so the work is answerable from any browser or phone, on a VPS you never sit at.",
            },
        ],
        table: [
            { label: "What it is", intentic: "the machine and fleet an agent works in", them: "an open harness that intentic can run" },
            {
                label: "Where the agent runs",
                intentic: "a Docker sandbox on hardware you own",
                them: "your machine through a terminal, desktop app or IDE",
            },
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
            {
                label: "Systems the agent can reach",
                intentic: "capabilities: GitHub, Postgres, Sentry, SSH, any MCP server",
                them: "MCP servers and your local tools",
            },
            {
                label: "Reach it from elsewhere",
                intentic: "any browser over a private tunnel, phone included",
                them: "runs where you launch it; share a session by link",
            },
            {
                label: "Starts on an event",
                intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events",
                them: "you start each session",
            },
            { label: "Licence", intentic: "MIT for the sandbox, platform and CLI", them: "MIT" },
            {
                label: "Runs without you at the keyboard",
                intentic: "automations on cron, webhook, push, alert, email, chat",
                them: "opencode run, in your own scripts and CI",
            },
        ],
        together: {
            title: "Add OpenCode as a capability",
            body: "OpenCode speaks ACP, and intentic takes any ACP agent as a capability. Run it on the same board as Claude Code and Codex, with your capabilities and automations around it.",
        },
        pickThem:
            "You want a lean, fully open terminal agent that stores nothing, you are happy launching it yourself, and you need no container, fleet board or events to start it.",
        sources: [
            { label: "Docs", url: "https://opencode.ai/docs/" },
            { label: "Source", url: "https://github.com/anomalyco/opencode" },
        ],
        meta: {
            title: "intentic vs OpenCode · an open harness, and the machine around it",
            description:
                "OpenCode is an MIT, provider-agnostic terminal agent storing no code. intentic runs harnesses like it in a container you own, with a board and automations.",
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
        sub: "Both are MIT, self-hosted and a tap away on a phone. What differs is where the agent is pointed, and what it leaves behind.",
        theirPitch:
            "“The AI that really does things.” OpenClaw is a self-hosted gateway with tools, skills and plugins from ClawHub. It works through WhatsApp, Telegram, Slack, Discord, Signal and iMessage.",
        verdict: [
            "A personal assistant you host yourself: a gateway on your own devices, reachable from whichever chat app is open, that clears an inbox, moves a calendar and turns off a light.",
            "intentic is a workplace for coding agents: a container, a worktree, credentials and a diff you read before anything lands. Different jobs, and they run together.",
        ],
        overlap: {
            title: "Where you agree",
            body: "almost line for line the same convictions: an agent doing real work belongs on your own machine, on your own model accounts, nothing proxied or marked up. Both are MIT, both extend through skills, both meet you on your phone.",
        },
        differences: [
            {
                title: "The artefact is a diff, not a reply",
                body: "An assistant's output is the message it sends and the change it already made. Here it is a change on a branch: every agent gets its own worktree, and nothing reaches your tree until you have read the diff.",
            },
            {
                title: "Different systems on the other end",
                body: "OpenClaw connects to mail, calendars, notes, music and home systems. intentic connects a sandbox to GitHub, Postgres, Sentry, Stripe, SSH or any MCP server, each credential kept inside.",
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
                them: "the chat apps you already use, including WhatsApp, Telegram, Signal and iMessage",
                theirs: true,
            },
            {
                label: "Reviewing what it did",
                intentic: "a diff reader you tick through, then accept or discard",
                them: "the reply in the thread, and git afterwards",
            },
            {
                label: "Where credentials live",
                intentic: "inside the sandbox, injected per turn",
                them: "with the gateway, on the device it runs on",
            },
            {
                label: "Runs unattended",
                intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events",
                them: "cron jobs, reminders and background tasks",
            },
            {
                label: "Extending it",
                intentic: "capabilities, extensions and any MCP server",
                them: "tools, skills and plugins from ClawHub",
                theirs: true,
            },
            { label: "Licence", intentic: "MIT for the sandbox, platform and CLI", them: "MIT" },
            { label: "Isolation", intentic: "a container and a git worktree per agent", them: "isolated sessions per agent, workspace or sender" },
        ],
        together: {
            title: "Hand the repository work over",
            body: "An intentic automation answers a webhook, so an assistant can start an agent here after spotting a failed nightly report. You can also invite it into the same Discord or Slack.",
        },
        pickThem:
            "Your work is across your life rather than a codebase: mail, meetings, notes and home systems, inside the chat app you already use, with no account or container runtime.",
        sources: [
            { label: "Docs", url: "https://docs.openclaw.ai/" },
            { label: "Source", url: "https://github.com/openclaw/openclaw" },
        ],
        meta: {
            title: "intentic vs OpenClaw · a personal assistant, and a workplace for agents",
            description:
                "OpenClaw is a self-hosted assistant that lives in your chat apps. intentic gives each coding agent a container, a worktree and a reviewable diff.",
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
        sub: "Both are MIT, self-hosted and answerable from a chat app. Hermes spends its effort on what an agent carries between sessions; intentic on what it runs inside.",
        theirPitch:
            "“The Agent That Grows With You.” Nous Research calls Hermes “the only agent with a built-in learning loop.” It creates skills from experience, improves them in use and builds a model of you across sessions.",
        verdict: [
            "A general-purpose agent with a learning loop: it writes its own skills, remembers across sessions, schedules its own work, and can put its terminal on Docker, SSH or a hosted sandbox. On memory it does something intentic does not attempt.",
            "intentic focuses on software work and the environment under it: a container you approve, a worktree, connections to your systems, and a diff before anything lands.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both are MIT and self-hosted, both run on your own model accounts, both can put the work in a container, both start on a schedule, and both reach you away from the desk.",
        },
        differences: [
            {
                title: "What is learned, and what is written down",
                body: "Hermes generates skills from experience and builds a model of you. intentic uses context you can edit: repo instructions, capability skills and task lists that survive a rebuild. If an agent has something wrong, you fix the file.",
            },
            {
                title: "Isolation is the floor, not a backend",
                body: "Hermes lets the terminal choose local, Docker, SSH or a hosted sandbox. Here there is no local option: every agent works inside its container, on its own worktree, and landing replays the delta as ordinary git you can amend or revert.",
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
            {
                label: "Where the work runs",
                intentic: "always a Docker sandbox on hardware you own",
                them: "local, Docker, SSH or a serverless sandbox, as configured",
            },
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
                them: "any endpoint, including Nous Portal, OpenRouter, OpenAI or your own",
                theirs: true,
            },
            {
                label: "Reviewing changes",
                intentic: "a diff reader over an isolated worktree, then accept or discard",
                them: "git, in the terminal it ran in",
            },
            {
                label: "Starts on an event",
                intentic: "automations: cron, webhook, chat, email, CI/CD, workspace events",
                them: "a natural-language cron scheduler",
            },
            { label: "Licence", intentic: "MIT for the sandbox, platform and CLI", them: "MIT" },
            { label: "Where the agent runs", intentic: "a Docker sandbox on hardware you own", them: "your own machine or server, self-hosted" },
            {
                label: "Runs without you at the keyboard",
                intentic: "automations on cron, webhook, push, alert, email, chat",
                them: "built-in cron, with delivery to any platform",
            },
        ],
        together: {
            title: "One machine, two jobs",
            body: "An intentic automation answers a webhook, so Hermes can hand repository work to an agent that gets a container, worktree and diff, then report back in the chat where you asked.",
        },
        pickThem:
            "You want one agent that writes its own skills, remembers past solutions and works from whichever chat app you use, on work reaching far beyond repositories.",
        sources: [
            { label: "Docs", url: "https://hermes-agent.nousresearch.com/docs" },
            { label: "Source", url: "https://github.com/NousResearch/hermes-agent" },
        ],
        meta: {
            title: "intentic vs Hermes · a self-improving assistant, and a sandbox per agent",
            description:
                "Hermes is Nous Research's self-improving assistant, MIT and self-hosted. intentic gives each coding agent a container, a worktree and a diff you approve.",
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
        sub: "Devin, Google Jules, Codex cloud, Claude Code on the web, Replit Agent. Everything else here composes with intentic. These do not, because they answer one question differently: whose computer holds your source.",
        theirPitch:
            "A hosted agent you give a task and a repository to. It clones your repo into the vendor's cloud VM, works there, and hands you a pull request.",
        verdict: [
            "Cloud agents have a polished setup: connect a repo and go. During the run, your code, keys and production access live in the vendor's sandbox.",
            "intentic keeps the same browser workflow with the sandbox on your own machine. The platform never handles commands or code, and the full MIT source is in one public repo.",
        ],
        overlap: {
            title: "Where you agree",
            body: "both supervise agents from a browser, run jobs in parallel, review a plan before work begins and a diff before anything lands.",
        },
        differences: [
            {
                title: "Custody, stated architecturally",
                body: "These platforms clone your repository into a vendor-managed VM: Jules and Claude Code call it a Cloud VM, Codex says “isolated cloud environments,” Devin sells Devin Cloud. With intentic your browser holds the command token, and the platform stores identity, a URL and grants, never your code or credentials.",
            },
            {
                title: "Your subscription and hardware, no meter",
                body: "Cloud platforms bill for the model and the machine, usually with a markup, from roughly $20 to $200 a month. intentic uses what you already have and charges nothing, so capacity is whatever your machine can run.",
            },
        ],
        table: [
            { label: "Where the agent runs", intentic: "your hardware", them: "the vendor's cloud VM" },
            { label: "Who can read your source", intentic: "you; the platform has no path to it", them: "the vendor, for the duration of the run" },
            { label: "How it gets your code", intentic: "it is already on your machine", them: "cloned from GitHub, or uploaded, into their VM" },
            { label: "Where your service credentials sit", intentic: "inside your sandbox", them: "in the vendor's secret store" },
            { label: "Model billing", intentic: "your own subscription, never metered by us", them: "the vendor's plan, usually with a markup" },
            { label: "Compute billing", intentic: "hardware you already own", them: "the vendor's, metered or bundled" },
            {
                label: "Supervision",
                intentic: "fleet board, plan mode, diff review, transcripts",
                them: "plan, diff and PR review, from the browser",
            },
            { label: "Setup", intentic: "Docker, a Google account, one pasted command", them: "connect a repo; nothing to host", theirs: true },
            {
                label: "Elastic capacity",
                intentic: "bounded by the machine you provide",
                them: "as many parallel agents as you will pay for",
                theirs: true,
            },
            {
                label: "Enterprise paperwork",
                intentic: "no certifications yet; the whole system is MIT and auditable",
                them: "established vendors with SOC 2, SSO and the certifications",
                theirs: true,
            },
            {
                label: "Isolation",
                intentic: "a container and a git worktree per agent, on your machine",
                them: "a vendor-run VM per task, with your repo cloned into it",
            },
            {
                label: "Review workflow",
                intentic: "the diff in the Changes panel, approved before it lands",
                them: "a draft pull request to review after the run",
            },
        ],
        pickThem:
            "You would rather not provide a machine, the repository is not sensitive, procurement needs a vendor with certifications in hand, and you want fifty parallel agents on a Tuesday without owning fifty cores.",
        sources: [
            { label: "Devin docs", url: "https://docs.devin.ai/get-started/devin-intro" },
            { label: "Jules docs", url: "https://jules.google/docs" },
        ],
        meta: {
            title: "intentic vs Devin, Jules and cloud agents · whose machine runs it",
            description:
                "Devin, Jules, Codex cloud and Replit clone your repo into the vendor's VM. intentic keeps the browser, with the sandbox on your own machine. Free and MIT.",
            datePublished: PUBLISHED,
        },
    },
];

export const comparePage = (slug: string): ComparePage | undefined => comparePages.find((page) => page.slug === slug);

/** The day every page's cited sources were last opened. Rendered on each comparison, so the age is the reader's to judge. */
export const compareVerifiedOn = VERIFIED;

export const familyPages = (id: string): ComparePage[] => comparePages.filter((page) => page.family === id);

/* The hub's own copy. It leads with the taxonomy rather than with us, because the reader's question is
 * "which of these things are you" and answering it first is what makes the rest credible. The two axes are
 * the ones that survived the field converging on parallel and cloud agents. */
export const compareIndex = {
    eyebrow: "Compare",
    heading: "See where intentic fits.",
    sub: "Some tools run inside intentic, others work alongside it, and a few replace part of what it does.",
    axes: {
        heading: "Compare any agent product with two questions",
        items: [
            {
                title: "Whose machine does the agent run on?",
                body: "The owner of that machine may be able to read your source code and credentials. This is the clearest difference between local and cloud products.",
            },
            {
                title: "How much of the agent's environment can you change?",
                body: "Instructions are only one part. Installed tools, connected systems and available context also decide whether an agent can finish the job.",
            },
        ],
    },
    correction: {
        title: "Found something out of date?",
        body: "These products change quickly. We check every claim against the vendor's own site on the date shown. If something is wrong, please open an issue.",
        cta: "Report an inaccuracy",
    },
    meta: {
        title: "How intentic compares · Cursor, Claude Code, Conductor, Superset, Devin",
        description:
            "Where intentic sits among agent CLIs, AI editors, assistants, local orchestrators and cloud platforms: Cursor, Claude Code, Conductor, Superset, Synara, Devin.",
        datePublished: PUBLISHED,
    },
};
