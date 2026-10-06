import { compareHref, comparePages } from "./compare";
import { docsHref } from "./docs";
import { productHref } from "./product";

// The guides shelf answers what people ask before they know intentic exists, built backwards from retrieval: title is
// the literal question, faq covers its other phrasings.
// - Nothing about another tool that isn't true of it as of `PUBLISHED`.
// - No invented benchmarks; omit a number rather than invent one.
// - If the honest answer is "you don't need this product," say so.

export const guidesHref = (slug: string): string => (slug ? `/guides/${slug}/` : `/guides/`);

/** Written against the state of the field on this date; the pages say so out loud. */
const PUBLISHED = "2026-08-12";
/** The second shelf: Docker sandboxes, self-hosted web agents, background agents and the parallel-tools roundup. */
const PUBLISHED_OCTOBER = "2026-10-06";

/** A compare link that appears only once its page exists, so a guide never points at a comparison still being written. */
const compareLink = (slug: string, label: string): { label: string; href: string }[] =>
    comparePages.some((page) => page.slug === slug) ? [{ label, href: compareHref(slug) }] : [];

/** One approach to the problem, including the ones this product does not sell. */
export interface GuideOption {
    name: string;
    /** What it actually is, in one line. */
    what: string;
    /** The case for it: a reader should be able to pick this and be right. */
    goodFor: string;
    /** Where it stops working. */
    breaksWhen: string;
}

/** A body section. Heading is a statement, and the first sentence under it answers the heading. */
export interface GuideSection {
    heading: string;
    /** Paragraphs. The first one carries the answer to the heading; the rest support it. */
    body: string[];
    /** Optional list under the prose, for the steps or conditions the prose refers to. */
    points?: string[];
}

export interface GuideFaq {
    /** Anchor id, so a single question is linkable and quotable on its own. */
    id: string;
    question: string;
    /** One paragraph. It has to survive being read with no page around it. */
    answer: string;
}

export interface GuidePage {
    slug: string;
    /** The h1, and the question itself. */
    question: string;
    /** Nav and card label: the question, shortened, still a question. */
    navLabel: string;
    /** One line of scent in listings. */
    blurb: string;
    /** Under 70 words, stands alone, names the mechanism; rendered under the h1 and reused as the meta description. */
    answer: string;
    /** Checkable specifics: the things a reader or a model can be right about after reading. */
    facts: string[];
    options: GuideOption[];
    /** The recommendation, stated plainly, after the options have been given their due. */
    verdict: string[];
    sections: GuideSection[];
    faq: GuideFaq[];
    /** Where to go next on this site. */
    related: { label: string; href: string }[];
    meta: { title: string; description: string; datePublished: string };
}

export const guidesIndex = {
    eyebrow: "Guides",
    heading: "Straight answers about running AI coding agents",
    sub: "What people ask before they know intentic exists. Each guide opens with a direct answer, weighs the approaches on the table, and says which one to actually pick.",
    meta: {
        title: "Guides · Running AI coding agents",
        description:
            "Practical answers about running AI coding agents: several at once, unattended, with credentials scoped safely and every change reviewed before it lands.",
        datePublished: PUBLISHED,
    },
};

export const guidePages: GuidePage[] = [
    {
        slug: "run-multiple-coding-agents-in-parallel",
        question: "Can several AI coding agents work on the same repository at once?",
        navLabel: "Agents in parallel",
        blurb: "Give each agent its own checkout so they cannot edit the same file, then pick how much isolation the work needs.",
        answer: "Give every agent its own checkout, so two can never edit the same file at once. Git worktrees do this on one machine for free. Containers go further, giving each agent its own processes, ports and installed tools. Then run each on its own branch and merge one at a time, reviewing each.",
        facts: [
            "The failure mode is shared state, not model quality: two agents in one working tree overwrite each other's edits and produce a build that neither of them broke.",
            "A git worktree is a second checkout of the same repository on a different branch, sharing one .git directory. Creating one is a single command and costs the size of the files, not the history.",
            "Worktrees isolate files. They do not isolate installed packages, running dev servers, ports, environment variables or databases, which is where parallel runs collide next.",
            "Practical limits are human before they are technical. Reviewing the output of ten agents takes longer than running them, so throughput is capped by how fast changes get read.",
            "Every agent CLI in common use (Claude Code, Codex, Grok, Kimi, Gemini) will run as several processes at once. None of them isolate each other by default.",
        ],
        options: [
            {
                name: "Several terminal tabs",
                what: "Run each agent CLI in its own terminal, all pointed at one checkout.",
                goodFor: "Two agents working on obviously separate areas, for an hour, when you are watching both.",
                breaksWhen:
                    "Anything touches a shared file, or one agent runs a formatter across the tree. There is no isolation at all, so the first collision is silent and shows up as a broken build later.",
            },
            {
                name: "Git worktrees, driven by hand",
                what: "One checkout per agent on its own branch, created with git worktree add.",
                goodFor:
                    "Most people, most of the time. It removes the file collision, which is the majority of the pain, and requires no new software.",
                breaksWhen:
                    "Agents need to run the app. Two dev servers want the same port, two test runs want the same database, and installed tool versions are shared across every worktree.",
            },
            {
                name: "A terminal multiplexer over worktrees",
                what: "tmux or a wrapper around it, giving each agent a pane and a worktree.",
                goodFor: "Watching several agents at once on one machine, and reattaching to them after an SSH session drops.",
                breaksWhen:
                    "You want to check on them from a phone, or the machine is your laptop and you need to close it. The session survives a disconnect but not a shutdown.",
            },
            {
                name: "A container per agent",
                what: "Each agent gets its own filesystem, processes, ports, package versions and credentials.",
                goodFor:
                    "Agents that install things, run services, migrate a database, or hold credentials you would rather not share between tasks.",
                breaksWhen: "The work is a one-line fix. The setup cost is real and a worktree would have done.",
            },
            {
                name: "A hosted cloud agent service",
                what: "The vendor runs the agents on their infrastructure and shows you the results.",
                goodFor: "Getting parallel work immediately with nothing to operate, and for teams who would rather buy the plumbing.",
                breaksWhen:
                    "Your code, your keys or your data cannot leave your infrastructure, or the per-seat cost stops making sense as usage grows.",
            },
        ],
        verdict: [
            "Start with git worktrees. They solve the collision that actually bites, they cost nothing, and you will find out within a day whether you need more.",
            "Move to a container per agent when the agents start needing an environment rather than just files: installing packages, running a dev server, holding a database password, or touching a system you do not want every task to reach.",
            "intentic chooses two layers deliberately: one Docker sandbox per workspace or trust boundary, then one isolated worktree per agent inside it. Use separate sandboxes when roles need different tools or credentials; use worktrees when agents may safely share the environment.",
        ],
        sections: [
            {
                heading: "Why parallel agents break: shared state, not the model",
                body: [
                    "Two agents pointed at one checkout will eventually write to the same file, and the second write wins silently. Nothing errors, and the damage surfaces later as a test failure neither agent caused, in a file neither of them was asked to change.",
                    "This is why isolation comes before orchestration. A dashboard that shows you six agents running is worth very little if all six share a working tree. The first decision is what each agent is allowed to see and change.",
                ],
                points: [
                    "One checkout per agent removes file collisions.",
                    "One branch per agent keeps the history readable and makes each result reviewable on its own.",
                    "One container per agent additionally removes port, package, process and credential collisions.",
                ],
            },
            {
                heading: "How many agents is realistic",
                body: [
                    "The ceiling is review capacity. Agents produce changes faster than anyone reads them, so the useful number is the number whose output you can actually get through, which for most people is somewhere between three and six on real work.",
                    "Cost is the second ceiling and it is easy to underestimate, because parallel agents multiply token spend at the same time as they multiply output. Watching per-agent spend from the start is worth more than tuning the count.",
                ],
            },
            {
                heading: "Merging without a queue of conflicts",
                body: [
                    "Land one agent's work at a time and rebase the rest onto the result. Agents that all branched from the same commit will each be slightly stale afterwards, and rebasing before review keeps the conflicts small and attributable.",
                    "Splitting work so that two agents rarely touch the same directory removes most of this problem before it starts. Task boundaries that follow module boundaries are worth more than any merge tooling.",
                ],
            },
            {
                heading: "What to give each agent beyond files",
                body: [
                    "Once agents run the code rather than only editing it, they need an environment each. That means their own ports, their own database, their own installed language versions, and their own copies of whatever credentials the job needs.",
                    "This is where worktrees stop being enough and a container per agent pays for itself. It is also where credential handling stops being theoretical: an agent that can reach production with a shared key is a real risk.",
                ],
            },
        ],
        faq: [
            {
                id: "how-many-agents-at-once",
                question: "How many AI coding agents can you run at once?",
                answer: "Technically as many as your machine has memory for. Practically the limit is how fast you can review what they produce, which puts most people between three and six on real work. Running more means the extra output gets merged unread, which removes the point.",
            },
            {
                id: "worktrees-or-containers",
                question: "Should each agent get a git worktree or a container?",
                answer: "A worktree if the agents only edit files, because it is one command and no new software. A container if the agents also install packages, run a dev server, use a database, or hold credentials, because worktrees share all of those and containers do not.",
            },
            {
                id: "same-repo-different-agents",
                question: "Can two agents work on the same repository at the same time?",
                answer: "Yes, provided each has its own checkout and branch. Two agents sharing one working tree will overwrite each other with no error, so isolation comes first. Git worktrees are the cheapest way to give each a separate checkout.",
            },
            {
                id: "mixing-different-agents",
                question: "Can you run different agent CLIs in parallel, such as Claude Code and Codex?",
                answer: "Yes. They are separate processes with separate accounts and do not know about each other, so mixing them is just isolating their working directories. Some people give the same task to two models and compare the diffs.",
            },
            {
                id: "parallel-agents-cost",
                question: "Does running agents in parallel cost more?",
                answer: "Yes, roughly in proportion to how many run, since each consumes its own tokens. The saving is wall-clock time, not money, so track spend per agent from day one rather than discovering the total at month end.",
            },
        ],
        related: [
            { label: "Parallel agents, in the docs", href: docsHref("parallel-agents") },
            { label: "Run a fleet", href: productHref("run") },
            { label: "Quickstart", href: docsHref("quickstart") },
            { label: "Tools for parallel agents, compared", href: guidesHref("best-tools-for-running-parallel-coding-agents") },
            { label: "intentic vs Superset", href: compareHref("superset") },
            ...compareLink("claude-squad", "intentic vs Claude Squad"),
        ],
        meta: {
            title: "How to run multiple AI coding agents in parallel",
            description:
                "Give each agent its own checkout so two can never edit the same file. When worktrees are enough, when a container per agent pays off, and how many to run.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "keep-a-coding-agent-running-after-you-close-your-laptop",
        question: "Will a coding agent keep working after you close your laptop?",
        navLabel: "Agents that persist",
        blurb: "Move the agent off the thing that sleeps. A detached session survives a disconnect; only another machine survives a lid close.",
        answer: "Run the agent somewhere that does not sleep. A multiplexer such as tmux keeps it alive when your SSH connection drops, but not when the machine suspends. To survive a closed laptop the agent has to be on a machine that stays awake: a desktop, a home server, a VPS. Everything else is a workaround.",
        facts: [
            "Closing a laptop lid suspends the CPU by default on macOS, Windows and most Linux desktops, which stops the agent process wherever it is running locally.",
            "tmux and screen survive a lost SSH connection or a closed terminal window, because the session is owned by a daemon rather than by your terminal. Neither survives the host suspending or rebooting.",
            "Preventing sleep (caffeinate on macOS, a power plan change on Windows) keeps a lid-closed laptop awake, at the cost of heat and battery, and only while it has power.",
            "An agent that is still running is not the same as an agent you can still see. Reattaching to a session requires being back at a terminal with access to that host.",
            "Agents that run unattended need a spend limit and a permission boundary set before they start, because nobody is watching to stop them.",
        ],
        options: [
            {
                name: "Stop the machine sleeping",
                what: "Keep the laptop awake with the lid shut, using the operating system's own power settings.",
                goodFor: "A run you expect to finish in an hour, on a machine that is plugged in and somewhere ventilated.",
                breaksWhen: "You need to travel, the battery runs out, or the machine reboots for an update. It also cooks a laptop in a bag.",
            },
            {
                name: "tmux or screen on the same machine",
                what: "The agent runs inside a session owned by a background daemon rather than your terminal window.",
                goodFor:
                    "Surviving a dropped SSH connection, a closed terminal, or an accidental window close. This is the right answer to that problem.",
                breaksWhen:
                    "The host suspends or restarts. The session dies with the machine, so this does not solve the closed laptop at all, which is the most common misunderstanding here.",
            },
            {
                name: "A second machine you own",
                what: "A desktop, a spare laptop, a home server or a VPS that stays on, reached over SSH or a tunnel.",
                goodFor: "Long runs, unattended automation, and anything where the code and credentials have to stay on hardware you control.",
                breaksWhen: "You have no such machine, or you are not willing to operate one. There is real setup and real maintenance.",
            },
            {
                name: "A hosted agent service",
                what: "The vendor runs the agent on their infrastructure; you start it from a browser and come back later.",
                goodFor: "Getting persistence with nothing to run or maintain, and for checking on work from a phone.",
                breaksWhen:
                    "The repository or its credentials cannot leave your infrastructure, or the work needs tools and services the host does not offer.",
            },
        ],
        verdict: [
            "If the problem is a dropped connection, use tmux. If the problem is a closed lid, no session manager will help and the agent has to move to a machine that stays on.",
            "The cheapest version of that is a desktop you already own, reached over SSH. The most convenient version is something that also gives you a way back in from a browser, so checking on the run does not require a terminal.",
            "intentic is built for the second case: the sandbox runs on your own desktop, server or VPS as a Docker container, keeps working with nothing connected to it, and is reachable from any device through a tunnel that dials outward. It is free and MIT licensed.",
        ],
        sections: [
            {
                heading: "What actually stops the agent",
                body: [
                    "Three different things get confused here, and they have three different fixes. Losing the terminal window kills a foreground process. Losing the SSH connection kills everything attached to that session. Suspending the machine stops all of it regardless.",
                    "tmux fixes the first two and does nothing for the third. This is worth being precise about, because the advice to just use tmux is given constantly to people whose actual problem is that they want to close a laptop.",
                ],
            },
            {
                heading: "Running unattended safely",
                body: [
                    "An agent working while nobody watches needs its limits set in advance. That means a spending cap, an explicit list of what it may touch, and work that lands somewhere reviewable rather than on the main branch.",
                    "The pattern that holds up: unattended work produces a proposal, not a result. The agent commits to its own branch and stops, and a person reads the diff before anything merges. Nothing depends on the agent having been right while unobserved.",
                ],
                points: [
                    "Set a spend limit before the run, not after.",
                    "Give the agent its own branch and no push access to the default branch.",
                    "Keep credentials scoped to the job, so an unattended mistake has limited reach.",
                    "Make sure the run leaves a log you can read afterwards to see what it did.",
                ],
            },
            {
                heading: "Getting back to a run in progress",
                body: [
                    "Persistence is only half of it. An agent that kept working but can only be reached from one terminal on one network is still a run you cannot check on from a train.",
                    "The useful shape is a process that stays on a machine you own, plus a way in that works from any device without exposing it to the internet. Outbound tunnels do this: the machine dials out and holds the connection open, so nothing inbound is opened.",
                ],
            },
        ],
        faq: [
            {
                id: "tmux-closed-laptop",
                question: "Does tmux keep an agent running when I close my laptop?",
                answer: "No. tmux keeps a session alive when your terminal closes or SSH drops, because it belongs to a background daemon. If the machine suspends, the daemon stops with everything else, and closing a laptop lid suspends by default.",
            },
            {
                id: "agent-on-vps",
                question: "Can I run a coding agent on a VPS?",
                answer: "Yes, and it is the usual answer for work that has to keep going. The agent runs on a machine that never sleeps, reached over SSH or a tunnel. The trade is that code and credentials now live there, so it needs the same care as any machine holding keys.",
            },
            {
                id: "check-agent-from-phone",
                question: "Can I check on a running agent from my phone?",
                answer: "Only if it is reachable over the network and has an interface that is not a terminal. A tmux session qualifies if you SSH in from the phone, but in practice this means a web interface on a machine that stays on.",
            },
            {
                id: "agent-overnight",
                question: "Is it safe to leave an agent working overnight?",
                answer: "It is safe when the limits are set beforehand: a spending cap, credentials scoped to the job, and work that lands on a branch for review. Without those, an unattended agent can spend a lot and change a lot before anyone looks.",
            },
        ],
        related: [
            { label: "Host agent work", href: productHref("host") },
            { label: "Your own machine, in the docs", href: docsHref("your-machine") },
            { label: "Automations", href: docsHref("automations") },
            { label: "Background agents on your own hardware", href: guidesHref("self-hosted-background-coding-agents") },
            { label: "Quickstart", href: docsHref("quickstart") },
            { label: "intentic vs Conductor", href: compareHref("conductor") },
        ],
        meta: {
            title: "Keep a coding agent running after you close your laptop",
            description:
                "tmux survives a dropped connection but not a sleeping machine. What actually keeps an agent working unattended, and how to set its limits before it runs.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "give-an-ai-agent-database-and-api-access-safely",
        question: "Should an AI coding agent ever hold your database password?",
        navLabel: "Credentials for agents",
        blurb: "Keep the secret out of the conversation. The agent should operate a tool that holds the credential, never read the credential itself.",
        answer: "Keep the credential out of the model's context. The agent should run a tool that already holds the secret, not be told the secret and asked to use it. That means a secret store the process reads, credentials scoped to the narrowest rights the job needs, and separate keys per task.",
        facts: [
            "Anything in the model's context can be repeated in its output, quoted into a log, or included in a message to another service. A pasted key is a disclosed key.",
            "A credential in an environment variable is readable by the process but never enters the conversation unless something prints it.",
            "Scoped, short-lived credentials limit damage without preventing work: a read-only database role, a token limited to one repository, a test-mode payment key.",
            "Agents run shell commands, so a credential the container can reach is a credential the agent can use, whether or not it can read the value.",
            "Isolation per task matters more than key strength. One key shared across every agent means any single mistake is a full compromise.",
        ],
        options: [
            {
                name: "Paste the key into the chat",
                what: "Give the agent the secret directly in its prompt or a config file it reads.",
                goodFor: "Nothing that touches a real system. It is worth naming because it is what people do first.",
                breaksWhen: "Immediately. The value is now in the context, in the provider's logs, and in whatever the agent writes next.",
            },
            {
                name: "Environment variables in the agent's process",
                what: "The credential is set in the environment the agent runs in, and tools read it from there.",
                goodFor: "Most local work. Simple, universally supported, and keeps the value out of the conversation.",
                breaksWhen: "Every agent on the machine shares one environment, so scoping per task means running separate processes anyway.",
            },
            {
                name: "A secret manager the tool calls",
                what: "The credential lives in a vault and is fetched at use time by the tool rather than held by the agent.",
                goodFor: "Teams, rotation, audit trails, and anywhere the same secret is used by more than one system.",
                breaksWhen:
                    "It is heavy for one person on one machine, and the agent still ends up with a usable session once the secret is fetched.",
            },
            {
                name: "A tool or MCP server that owns the credential",
                what: "The agent calls an operation such as query or deploy, and the credential sits inside the tool where the model never sees it.",
                goodFor: "Giving an agent real capability with a bounded surface. The agent gets verbs rather than keys.",
                breaksWhen:
                    "The available operations do not cover the job, at which point people hand over the raw credential and undo the whole arrangement.",
            },
            {
                name: "A separate container per task, credentials inside",
                what: "Each agent runs in its own sandbox holding only the credentials that task needs.",
                goodFor: "Running several agents with different access, and keeping a mistake contained to one task.",
                breaksWhen: "There is setup to do, and it does not remove the need to scope the credentials themselves.",
            },
        ],
        verdict: [
            "Two rules do most of the work. The credential never enters the model's context, and each task gets only the access it needs.",
            "In practice that means tools holding secrets rather than agents holding secrets, plus per-task isolation so the scope of any single mistake is small.",
            "intentic scopes capabilities to a sandbox, not to each conversation. A capability installs a real tool and its credential there, and the value never leaves that boundary. Put roles with different authority in separate sandboxes; worktrees isolate concurrent code changes, not credentials.",
        ],
        sections: [
            {
                heading: "The rule that matters: context is disclosure",
                body: [
                    "Treat everything the model can see as published. It can be echoed into output, written into a file, quoted in a commit message, or sent to another service the agent is allowed to call. None of that requires the model to be malicious, only unlucky.",
                    "This is why the fix is structural rather than behavioural. Asking an agent not to print a secret is a request; keeping the secret out of its context is a guarantee.",
                ],
            },
            {
                heading: "Scope beats secrecy",
                body: [
                    "A read-only database role that leaks is an incident. A write-capable production role that leaks is a catastrophe. Most of the safety available here comes from deciding what the credential can do, before deciding how well it is hidden.",
                    "The practical version is unglamorous and effective: a separate credential per task, the narrowest permission that lets the work happen, and a short life so an old leak stops mattering.",
                ],
                points: [
                    "Read-only wherever the job does not require writes.",
                    "One credential per task rather than one shared across every agent.",
                    "Test or staging systems by default, with production access as a deliberate exception.",
                    "Rotation that someone actually performs, which usually means short-lived tokens rather than a calendar reminder.",
                ],
            },
            {
                heading: "What isolation buys you",
                body: [
                    "A container per agent changes the question from whether an agent will make a mistake to how far it reaches. An agent with a staging credential and no route to production cannot cause a production incident, whatever it does.",
                    "This is also what makes running several agents at once tolerable. Without isolation, every agent shares one environment and one set of keys, so any single task can affect the whole machine.",
                ],
            },
        ],
        faq: [
            {
                id: "safe-to-give-agent-db-access",
                question: "Is it safe to give an AI agent access to a database?",
                answer: "It is safe in proportion to what the credential can do. A read-only role on a staging copy is low risk and often enough. A write-capable production role is a serious risk whatever the model, and should be a deliberate exception.",
            },
            {
                id: "does-the-model-see-my-key",
                question: "Does the AI model see my API key?",
                answer: "Only if it reaches the context. A key in an environment variable or held inside a tool is used by the process without being shown to the model. A key pasted into a prompt, or printed by a command the agent ran, should be treated as disclosed.",
            },
            {
                id: "env-vars-enough",
                question: "Are environment variables good enough for agent credentials?",
                answer: "For one person on one machine, usually yes: they keep the value out of the conversation. They stop being enough when several agents share the machine and all see the same environment, or when the credential needs rotation and an audit trail.",
            },
            {
                id: "mcp-server-credentials",
                question: "Do MCP servers keep credentials away from the model?",
                answer: "Yes, that is one reason to use them. The server holds the credential and exposes operations, so the agent calls a query rather than receiving a connection string. The protection is only as good as the operations exposed: a tool that returns the raw secret gives the model the secret.",
            },
            {
                id: "agent-leaks-secret",
                question: "What happens if an agent leaks a secret?",
                answer: "Treat it as a live disclosure and rotate immediately: the value may sit in provider logs, in files the agent wrote, and in session history. This is the argument for short-lived, narrowly scoped credentials.",
            },
        ],
        related: [
            { label: "Connect agents to your systems", href: productHref("connect") },
            { label: "Capabilities, in the docs", href: docsHref("capabilities") },
            { label: "Access and permissions", href: docsHref("access") },
            { label: "Claude Code in a Docker sandbox", href: guidesHref("run-claude-code-in-a-docker-sandbox") },
            { label: "Quickstart", href: docsHref("quickstart") },
            { label: "intentic vs cloud agents", href: compareHref("cloud-agents") },
        ],
        meta: {
            title: "How to give an AI agent database and API access safely",
            description:
                "Keep the credential out of the model's context and scope it to the task. Env vars, secret managers, tools that hold the key, and what each one protects.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "review-ai-generated-code-changes",
        question: "Is an AI agent's summary of its own diff enough to merge on?",
        navLabel: "Reviewing agent work",
        blurb: "Read the diff, not the summary. Make the agent's work land somewhere that requires a decision to merge.",
        answer: "Make the agent's work land somewhere that cannot merge itself, then read the diff rather than the agent's description of it. That means a branch per agent, every hunk reviewed before merge, and tests on the branch. The summary is a claim about the change; the diff is the change.",
        facts: [
            "An agent's summary and its diff can disagree, without dishonesty, because the summary is generated from intent rather than from the final state of the files.",
            "The most common surprises in agent diffs are collateral: a reformatted file, a bumped dependency, a deleted test that was failing, a stray debug line.",
            "Review effort scales with diff size, so the strongest lever is asking for smaller changes rather than reviewing faster.",
            "Plan-first workflows, where the agent states its approach and waits for approval, catch wrong-direction work before any code is written and are cheaper than reviewing the result.",
            "A test suite that runs on the branch converts part of review into something automatic, which is what makes larger volumes of agent work tolerable.",
        ],
        options: [
            {
                name: "Read the agent's summary and merge",
                what: "Trust the description of what changed.",
                goodFor: "Throwaway work, prototypes, and code nobody will run.",
                breaksWhen: "The summary describes intent rather than result. Collateral changes are exactly the ones that do not appear in it.",
            },
            {
                name: "git diff before committing",
                what: "Read the working tree changes yourself, in the terminal or an editor.",
                goodFor: "Small changes, and anyone already comfortable reading diffs. It is the honest minimum.",
                breaksWhen: "The change is large, or several agents are working, at which point the diffs pile up faster than they get read.",
            },
            {
                name: "A branch and a pull request per agent",
                what: "Each agent's work becomes a PR that a person approves, with CI attached.",
                goodFor: "Teams, anything with existing review culture, and getting automated checks for free.",
                breaksWhen:
                    "For one person on their own machine the ceremony can be heavier than the work, and PR review still needs someone reading hunks.",
            },
            {
                name: "Plan approval before any code",
                what: "The agent states what it intends to change and waits for approval before writing.",
                goodFor: "Catching a misunderstanding at the cheapest possible moment, before there is a diff at all.",
                breaksWhen: "It does not replace reading the result, because plans and outcomes diverge. It reduces review, it does not remove it.",
            },
            {
                name: "Tests and checks on the branch",
                what: "The suite, the type checker and the linter run before a human looks.",
                goodFor: "Turning a class of review into something that happens automatically, which is what makes volume workable.",
                breaksWhen: "Coverage is thin, or the agent adjusted the tests. Both are common enough to check for specifically.",
            },
        ],
        verdict: [
            "Two habits carry most of the value. Approve the plan before the work starts, and read the diff rather than the description before it lands.",
            "Everything else is about making those two affordable: smaller tasks, tests on the branch, and one agent's work at a time so each diff is attributable.",
            "intentic arranges the workflow that way by default. Every agent starts in plan mode, permission is a per-turn decision, finished work waits on its own branch, and the changes are reviewed hunk by hunk before anything reaches your working tree.",
        ],
        sections: [
            {
                heading: "Read the diff, not the summary",
                body: [
                    "An agent writes its summary from what it set out to do. The diff records what actually happened, including everything the agent did not think worth mentioning. Those are the same changes that break a build a week later.",
                    "Reading every hunk sounds slow and mostly is not, because the surprising parts stand out immediately: a file nobody asked about, a dependency version, a deleted assertion.",
                ],
                points: [
                    "Check the file list before the contents, because an unexpected filename is the fastest signal available.",
                    "Look specifically at test files, since a passing suite means less if the assertions moved.",
                    "Check dependency and lockfile changes, which are easy to skim past and hard to undo quietly.",
                    "Look for debugging leftovers, commented-out code, and files added outside the task's scope.",
                ],
            },
            {
                heading: "Make small changes the default",
                body: [
                    "The single most effective review technique is asking for less at a time. A four-file diff gets read properly; a forty-file diff gets skimmed, and skimming is where the mistakes get through.",
                    "This also improves the work itself, because a narrow task gives the agent less room to invent scope and less context to lose track of.",
                ],
            },
            {
                heading: "Where automation genuinely helps",
                body: [
                    "Type checkers, linters and tests catch the categories of error that are tedious for a person to find, and they scale with the number of agents in a way that human attention does not.",
                    "What they do not catch is whether the change was the right thing to build. That remains a judgement, which is the argument for approving the plan up front rather than discovering the misunderstanding in the diff.",
                ],
            },
        ],
        faq: [
            {
                id: "trust-ai-code",
                question: "Can you trust code written by an AI agent?",
                answer: "Treat it like a competent contributor who does not know your codebase's history: usually right in the small, occasionally confident about something wrong, worth reviewing every time. The answer is not trust or distrust, but a workflow where nothing merges unread.",
            },
            {
                id: "what-to-look-for",
                question: "What should you look for when reviewing AI-generated code?",
                answer: "Start with the list of changed files: unexpected filenames are the fastest signal. Then check test changes, dependency and lockfile changes, and anything outside the task's stated scope. Collateral edits are the usual problem, not wrong logic where you asked.",
            },
            {
                id: "should-agents-commit",
                question: "Should an AI agent be allowed to commit and push?",
                answer: "Committing to its own branch is fine and makes the work reviewable. Pushing to a shared default branch removes the review step entirely, which is the one control that catches everything else. Keep the branch, keep the merge as a human decision.",
            },
            {
                id: "review-many-agents",
                question: "How do you review the work of several agents at once?",
                answer: "Serially, one branch at a time, with tests already run on each. Review capacity is the real limit on parallel agents, so the way to raise it is smaller tasks and automated checks rather than reading faster.",
            },
        ],
        related: [
            { label: "Review agent work", href: productHref("review") },
            { label: "Capabilities and permissions", href: docsHref("access") },
            { label: "Background agents and review", href: guidesHref("self-hosted-background-coding-agents") },
            { label: "Quickstart", href: docsHref("quickstart") },
            { label: "intentic vs Cursor", href: compareHref("cursor") },
        ],
        meta: {
            title: "How to review code an AI agent wrote before it lands",
            description:
                "Read the diff rather than the summary, approve the plan before the work, and keep changes small. What to check first, and where automation helps.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "where-your-code-goes-with-cloud-coding-agents",
        question: "Where does your code go when you use a cloud coding agent?",
        navLabel: "Where your code goes",
        blurb: "Two questions decide it: whose machine holds the checkout, and whose account holds the keys.",
        answer: "It depends on where the agent runs, and there are two questions: whose machine holds the checkout, and whose account holds the credentials. A cloud service clones your repository onto its infrastructure and holds tokens for you. A local agent keeps both on your machine and sends only the conversation to the model provider.",
        facts: [
            "Every approach sends something to a model provider, because the model is remote unless you are running a local one. What differs is whether that is only conversation text or also a full checkout.",
            "A local agent CLI sends the file contents it decides to read, along with your instructions, and keeps the repository and credentials on your machine.",
            "A hosted agent service clones the repository onto its own infrastructure, which usually means granting it repository access through an integration that can read more than the one repository.",
            "Model providers publish separate policies for consumer and business plans, and training on submitted content is commonly opt-out on one and off by default on the other. This is worth checking for your specific plan rather than assuming.",
            "Self-hosting the agent does not make the model local. It changes who holds the checkout and the keys, not where inference happens.",
        ],
        options: [
            {
                name: "An agent CLI on your own machine",
                what: "The agent runs locally; the repository and credentials never leave the machine.",
                goodFor: "Keeping code and keys in one place while still using a hosted model. The most common arrangement.",
                breaksWhen:
                    "The machine sleeps or you want to reach the run from elsewhere, which is a persistence problem rather than a privacy one.",
            },
            {
                name: "A self-hosted container",
                what: "The same as above, with a containerized workspace on your desktop, server or VPS. Several agents can share it while editing isolated worktrees.",
                goodFor: "Running unattended work and several agents at once while keeping everything on your machine.",
                breaksWhen: "You do not want to operate a machine. There is real, if small, ongoing maintenance.",
            },
            {
                name: "A hosted cloud agent service",
                what: "The vendor clones your repository and runs the agent on their infrastructure.",
                goodFor: "Speed and convenience with nothing to run, and reaching work from anywhere by default.",
                breaksWhen: "Policy or contract forbids code leaving your infrastructure, or the access grant is broader than you want to give.",
            },
            {
                name: "A locally hosted model",
                what: "Inference runs locally, so no conversation content leaves at all.",
                goodFor: "The strictest requirements, and situations where no external processing is acceptable.",
                breaksWhen:
                    "Capability. Local models remain behind the frontier hosted ones on long agentic coding tasks, and the hardware is not free.",
            },
        ],
        verdict: [
            "Ask the two questions separately. Whose machine holds the checkout, and whose account holds the credentials. Most of what people mean by privacy here is answered by those two rather than by any policy document.",
            "If the answer has to be your own machine for both, a locally run agent is the baseline. A containerized workspace on a desktop, server or VPS adds a durable boundary and can keep working after the laptop closes.",
            "That is what intentic does. The sandbox runs on your machine, the repository and credentials stay inside it, and the platform stores only your identity and the sandbox's address. It is MIT licensed, so the claim is checkable rather than promised. If you would rather not host anything, one free starter box runs on our infrastructure instead: the honest trade, spelled out in the privacy policy, is that its disk is then ours rather than yours.",
        ],
        sections: [
            {
                heading: "Two questions, not one",
                body: [
                    "Where the checkout lives and where the keys live are separate decisions, and conflating them is how people get surprised. An agent on your laptop with a production token has kept your code local and handed out real access. A hosted agent with a read-only token has done the reverse.",
                    "Answer both explicitly for whatever you are evaluating, because a vendor page usually addresses one of them clearly and the other in passing.",
                ],
            },
            {
                heading: "What reaches the model either way",
                body: [
                    "Any hosted model receives the parts of your code the agent chose to read, plus your instructions and the tool output from the session. That is true of local agents too, and it is the part people most often assume is avoided by running locally.",
                    "The difference a local setup makes is that nothing else is transferred: no full clone sitting on someone else's disk, no long-lived repository access granted to a third party, no credentials held in another account.",
                ],
            },
            {
                heading: "Checking a claim rather than believing it",
                body: [
                    "The claims worth verifying are concrete: what the vendor stores, how long they keep it, whether submitted content is used for training on your specific plan, and what the access grant actually permits.",
                    "Open source helps here in a specific way. It does not prove what a hosted service does with your data, but it does let you read what the software on your own machine sends and to where, which is the part you can otherwise only take on faith.",
                ],
            },
        ],
        faq: [
            {
                id: "does-my-code-get-uploaded",
                question: "Does my code get uploaded when I use an AI coding agent?",
                answer: "With a local agent, the files it reads go to the model provider as conversation content, and the repository stays on your machine. With a hosted service, the repository is cloned onto the vendor's infrastructure too. Both send something; only one sends a full copy.",
            },
            {
                id: "is-my-code-used-for-training",
                question: "Is my code used to train the model?",
                answer: "It depends on the provider and the plan. Business and enterprise tiers commonly exclude submitted content from training by default; consumer tiers often allow it with an opt-out. The policy for your plan is the only reliable answer, and it is worth reading.",
            },
            {
                id: "self-hosted-means-private",
                question: "Does self-hosting the agent mean nothing leaves my network?",
                answer: "No, unless the model is also local. Self-hosting changes who holds the checkout and the credentials, which is significant, but the model is still remote and still receives the conversation. Only running a local model removes external processing entirely.",
            },
            {
                id: "safest-setup",
                question: "What is the most private way to use a coding agent?",
                answer: "A local model on your machine, with the agent local too, sends nothing anywhere. The realistic compromise is a self-hosted agent with a hosted model on a plan that excludes training, which keeps the repository and credentials on hardware you control.",
            },
        ],
        related: [
            { label: "Host agent work", href: productHref("host") },
            { label: "Your own machine, in the docs", href: docsHref("your-machine") },
            { label: "Which models it uses", href: docsHref("models") },
            { label: "Self-hosting instead of Claude Code on the web", href: guidesHref("self-hosted-alternative-to-claude-code-on-the-web") },
            { label: "Quickstart", href: docsHref("quickstart") },
            { label: "intentic vs cloud agents", href: compareHref("cloud-agents") },
        ],
        meta: {
            title: "Where does your code go when you use a cloud coding agent?",
            description:
                "Whose machine holds the checkout, and whose account holds the keys. What each setup sends to a model provider, and which claims are worth verifying.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "run-claude-code-in-a-docker-sandbox",
        question: "How do you run Claude Code in a Docker sandbox?",
        navLabel: "Claude Code in Docker",
        blurb: "The container becomes the permission boundary. Decide what it can see, reach and hold before you turn the prompts off.",
        answer: "Run Claude Code in a container that sees only the repository you mount, holds only the credentials the task needs, and can reach only the hosts you allow. The container then becomes the boundary, which is what makes --dangerously-skip-permissions reasonable. Anthropic publishes a reference devcontainer with a default-deny firewall; Docker Sandboxes and managed workspaces package the same idea.",
        facts: [
            "Anthropic's docs say to run --dangerously-skip-permissions sessions only inside a container, a VM or its sandbox runtime. The CLI refuses the flag when it runs as root.",
            "A container does not stop exfiltration on its own. Anthropic's devcontainer docs warn that with permissions skipped, a malicious project can send out anything reachable inside the container, including Claude Code's own credentials. The network policy is what limits that.",
            "A bind-mounted repository is your real files. Whatever the agent deletes or rewrites in the mount is deleted or rewritten on the host, container or not.",
            "Claude Code keeps its sign-in in its config directory, and on Linux the credential file is ~/.claude/.credentials.json. Without a volume for that directory, and CLAUDE_CONFIG_DIR pointing at it, a container asks you to log in on every start.",
        ],
        options: [
            {
                name: "Claude Code's built-in sandbox",
                what: "Turn on /sandbox and Claude's shell commands run under OS limits: writes kept to the project, network through a proxy whose allowlist starts empty.",
                goodFor: "Fewer prompts on your own laptop without Docker. Nothing to build, and it works on macOS, Linux and WSL2.",
                breaksWhen:
                    "You want the whole agent contained. File tools, MCP servers and hooks run outside it, reads cover most of the machine including ~/.ssh by default, and native Windows is not supported.",
            },
            {
                name: "Anthropic's reference devcontainer",
                what: "A devcontainer.json, Dockerfile and init-firewall.sh from the claude-code repository: a non-root user, a volume for Claude's config, and a default-deny firewall with a short allowlist.",
                goodFor:
                    "VS Code or any editor that opens devcontainers, teams that want one shared definition, and a network policy you can read line by line.",
                breaksWhen:
                    "You need hosts outside the allowlist, such as another package registry or your own APIs: every new source is a firewall edit. Anthropic calls it a working example, not a maintained base image.",
            },
            {
                name: "Plain docker run",
                what: "Your own image with Claude Code installed, the repository bind-mounted, a named volume for the config, started by hand or from a script.",
                goodFor: "Full control with nothing to learn beyond Docker, and easy to run headless with claude -p from a script or a CI job.",
                breaksWhen:
                    "You forget the parts the devcontainer gives you: a non-root user, a persisted login and network limits. By default a container can reach the whole internet.",
            },
            {
                name: "Docker Sandboxes",
                what: "Docker's sbx CLI runs Claude Code in a microVM with its own kernel, Docker daemon and network, with the workspace mounted at the same path as on the host.",
                goodFor:
                    "A stronger boundary than a container, Docker inside the sandbox, default-deny networking with presets, and credentials injected by a host-side proxy so the raw key never enters the VM. Free for local use.",
                breaksWhen:
                    "Your machine is not macOS 14 on Apple silicon, Windows 11 or Ubuntu 24.04 or later, or you want several agents managed with review on top. It needs a Docker sign-in, and it is the boundary rather than the workflow.",
            },
            {
                name: "A self-hosted agent workspace",
                what: "Something that runs the container for you and puts an interface on it. intentic runs a Docker sandbox on your machine, with a git worktree per agent inside it.",
                goodFor:
                    "Several agents, runs that keep going after the terminal or browser closes, and review before changes reach your checkout, without writing the container setup yourself.",
                breaksWhen:
                    "You need one agent in one repository for an afternoon, or you need default-deny egress: intentic's sandbox does not filter outbound traffic, so that policy would be yours to add.",
            },
        ],
        verdict: [
            "If all you want is fewer prompts on your own laptop, turn on /sandbox first. It is built in and covers the shell, which is where most of the risk sits.",
            "If you want to run with --dangerously-skip-permissions, use a real boundary. Anthropic's reference devcontainer is the best one to read and copy, because the firewall is a script you can audit. Docker Sandboxes gives a stronger boundary with less to maintain, on the platforms it supports.",
            "Once there are several agents, or runs that should continue after you close the terminal, the container is only half the job. intentic runs Claude Code, Codex, Grok and others in a Docker sandbox on your machine, with a worktree per agent, credentials held inside the sandbox, and every change reviewed before it lands.",
        ],
        sections: [
            {
                heading: "What the container protects, and what it does not",
                body: [
                    "A container turns the question of what Claude may do into what this box can reach. Inside it, prompts mostly become noise: a command approved without being read is worse than a boundary nobody has to think about.",
                    "It protects the host: files outside the mount, other projects, your SSH keys, your browser profile. It does not protect anything you put inside it. That is why three decisions matter more than the image: what you mount, which credentials go in, and where the network can go.",
                ],
            },
            {
                heading: "Mounting the repository",
                body: [
                    "Bind-mount the repository and the agent edits your real checkout, so changes show up in your editor straight away. That is the convenient default, and also why a mistake inside the container is a real mistake on the host.",
                    "The alternative is a copy inside the container, which isolates the work completely and makes getting it out a git push or a patch. Docker Sandboxes offers both: a direct mount at the same path as on the host, or a clone mode that mounts the repository read-only and gives the agent a private copy.",
                ],
                points: [
                    "Mount the repository, never your home directory.",
                    "Run as a non-root user whose uid matches yours, or files created in the container come out owned by root.",
                    "Keep dependency folders such as node_modules inside the container when the host is macOS or Windows: native modules built for one system do not load on the other.",
                ],
            },
            {
                heading: "Credentials: give it a login, not your keys",
                body: [
                    "Claude Code needs a credential of its own, and there are three ways to give it one. Log in inside the container, pasting the code it shows because the browser callback cannot reach the container, and keep the config directory on a volume. Generate a one-year token on the host with claude setup-token and pass it as CLAUDE_CODE_OAUTH_TOKEN, which needs a Pro, Max, Team or Enterprise plan. Or pass ANTHROPIC_API_KEY, which uses API billing instead of your plan.",
                    "Everything else the job needs should be scoped to the job: a token for one repository rather than your SSH key, a staging database rather than production. Anthropic's devcontainer docs specifically say to avoid mounting host secrets such as ~/.ssh.",
                ],
            },
            {
                heading: "Network limits: the part most setups skip",
                body: [
                    "A plain docker run has full outbound access, so an agent with skipped permissions can send anything it can read to anywhere. The fix is default-deny egress with an allowlist.",
                    "Anthropic's reference firewall does this with iptables when the container starts. It allows DNS, SSH, GitHub's published address ranges, the npm registry and the Anthropic API, rejects everything else, and checks itself by confirming that example.com is unreachable. It needs the NET_ADMIN and NET_RAW capabilities to do so. Docker Sandboxes enforces a similar policy outside the VM, with Open, Balanced and Locked Down presets.",
                    "An allowlist is only as tight as its widest entry: Docker's docs warn that its defaults include broad wildcards.",
                ],
            },
            {
                heading: "What breaks inside the box",
                body: ["Most of the friction is predictable, and worth knowing before the first run rather than during it."],
                points: [
                    "Installs from a registry that is not on the allowlist. Every new dependency source is a firewall change.",
                    "Docker inside the container. Mounting the host's Docker socket gives the agent root-level control of the host and undoes the sandbox. Use a sandbox with its own engine: Docker Sandboxes has one per sandbox, and intentic's is a capability you switch on.",
                    "Logging in again on every start, until the config directory lives on a volume.",
                    "Ports. A dev server inside the container is invisible until its port is published, and two containers cannot publish the same one.",
                    "Root images. Claude Code refuses --dangerously-skip-permissions as root, so an image that defaults to root needs a user added.",
                ],
            },
        ],
        faq: [
            {
                id: "skip-permissions-in-docker",
                question: "Is it safe to use --dangerously-skip-permissions in Docker?",
                answer: "Safer, not safe. The container protects the host outside the mount, but Anthropic warns that a malicious project can still exfiltrate anything inside it, including Claude's own credentials, unless the network is restricted. Use it with trusted repositories, a non-root user, scoped credentials and default-deny egress.",
            },
            {
                id: "need-a-devcontainer",
                question: "Do I need a devcontainer to run Claude Code in Docker?",
                answer: "No. A devcontainer is a Docker setup that editors such as VS Code know how to open. A plain docker run with the repository mounted works the same way for the agent. The devcontainer earns its keep through Anthropic's reference firewall and as one shared definition for a team.",
            },
            {
                id: "login-inside-container",
                question: "How do you log in to Claude Code inside a container?",
                answer: "Run claude and paste the code it shows, since the browser callback cannot reach the container, and keep the config directory on a volume so the login survives restarts. For unattended runs, create a token on the host with claude setup-token and pass it in as CLAUDE_CODE_OAUTH_TOKEN.",
            },
            {
                id: "docker-sandboxes-vs-devcontainer",
                question: "What is the difference between Docker Sandboxes and a devcontainer?",
                answer: "A devcontainer is a container on your Docker engine, sharing the host's kernel, defined by a file in your repository. Docker Sandboxes runs each agent in a microVM with its own kernel, Docker daemon and network policy, and injects credentials from the host so raw keys never enter it. The microVM is the stronger boundary; the devcontainer is a file you can read and change.",
            },
            {
                id: "claude-code-built-in-sandbox",
                question: "Does Claude Code have a sandbox of its own?",
                answer: "Yes: /sandbox. It confines the shell commands Claude runs, using Seatbelt on macOS and bubblewrap on Linux and WSL2, with network access through an allowlist that starts empty. It is off by default and does not cover Claude's file tools, MCP servers or hooks, so it is a layer rather than a full boundary.",
            },
        ],
        related: [
            { label: "Credentials for agents", href: guidesHref("give-an-ai-agent-database-and-api-access-safely") },
            { label: "Tools for parallel agents", href: guidesHref("best-tools-for-running-parallel-coding-agents") },
            { label: "Docker setup, in the docs", href: docsHref("docker") },
            { label: "intentic vs Claude Code", href: compareHref("claude-code") },
            ...compareLink("docker-sandboxes", "intentic vs Docker Sandboxes"),
        ],
        meta: {
            title: "How to run Claude Code in a Docker sandbox",
            description:
                "Run Claude Code in a container that sees only your repo and reaches only allowed hosts. Devcontainer, docker run, Docker Sandboxes, credentials, what breaks.",
            datePublished: PUBLISHED_OCTOBER,
        },
    },
    {
        slug: "self-hosted-alternative-to-claude-code-on-the-web",
        question: "Is there a self-hosted alternative to Claude Code on the web or Codex cloud?",
        navLabel: "Self-hosted web agents",
        blurb: "Keep the agent and the checkout on a machine you run, then add a way in from the browser. Uptime becomes your job.",
        answer: "Yes. Run the same agent CLI on a machine you control and add a way to reach it: SSH and tmux, Anthropic's Remote Control, an open-source web UI, or a self-hosted workspace. The checkout and credentials stay on your hardware, and turns still use your subscription. What you take on is the part the cloud products sell: a machine that stays on, and its environment.",
        facts: [
            "Claude Code on the web runs each session in an Anthropic-managed VM on Pro, Max, Team and eligible Enterprise seats, with no separate compute charge; sessions share your plan's rate limits. Codex cloud runs each task in a VM on OpenAI's side and is listed from ChatGPT Plus up.",
            "Both start from GitHub. Codex cloud does not yet support GitLab or GitHub Enterprise Server. Claude Code on the web needs GitHub to clone and open pull requests, though claude --cloud can upload a bundle of a local repository instead.",
            "Self-hosting the agent does not make the model local. The conversation and the files the agent reads still go to the model provider. What moves is the checkout, the environment and the credentials.",
            "Anthropic's Remote Control already lets claude.ai and the Claude mobile app drive a session running on your own machine over outbound HTTPS. The local process has to keep running, and it needs a subscription login: API keys are not supported.",
            "A web UI listening on a public address without authentication is a shell for whoever finds it. OpenCode's docs say plainly that its server is unsecured unless you set a password.",
        ],
        options: [
            {
                name: "Stay on the cloud product",
                what: "Claude Code on the web, Codex cloud, or a peer such as Cursor's cloud agents. The vendor runs a fresh VM per task.",
                goodFor: "Operating nothing, starting work from a phone, parallel sessions on someone else's hardware, and no extra charge on plans that include it.",
                breaksWhen:
                    "Code or credentials must stay on your infrastructure, the repository is not on GitHub, or the environment needs more than a setup script can install. Shell commands in Claude Code cloud sessions time out after two minutes by default, ten at most.",
            },
            {
                name: "SSH, tmux and the CLI",
                what: "The agent runs in tmux on a desktop, home server or VPS; you reattach over SSH from wherever you are.",
                goodFor: "Anyone at home in a terminal. Free, nothing to trust beyond SSH, and the session survives a dropped connection.",
                breaksWhen:
                    "You want to check in from a phone without a terminal app, watch several agents at once, or read diffs comfortably. It is all text in one window.",
            },
            {
                name: "Claude Code Remote Control",
                what: "Start claude remote-control on your machine and continue the session from claude.ai/code or the Claude app.",
                goodFor: "Claude users who want the official web and phone interface on a session that runs locally, with no inbound port opened.",
                breaksWhen:
                    "You use another agent, or the local process stops: Anthropic suggests tmux over SSH to keep it alive, and server mode exits after about ten minutes without a network.",
            },
            {
                name: "An open-source web UI",
                what: "Claude Code UI (now CloudCLI, AGPL-3.0), Happy (MIT, phone and web through an encrypted relay you can self-host) or opencode web (MIT) put a browser in front of agents on your machine.",
                goodFor: "A free browser or phone front end for agents you already run, if you are happy to set it up and secure it.",
                breaksWhen:
                    "It is exposed carelessly, since its security is whatever you put in front of it. Most are a view onto sessions rather than isolation between them.",
            },
            {
                name: "A self-hosted workspace",
                what: "intentic: a Docker sandbox on your laptop, desktop or VPS that runs Claude Code, Codex, Grok, Kimi Code and Gemini, reached from any browser through a tunnel it dials outward.",
                goodFor:
                    "The shape of the cloud products on your own hardware: runs that continue with the browser closed, a worktree per agent, plan mode and per-hunk review, on the subscriptions you already have.",
                breaksWhen:
                    "You do not want to keep a machine on. A sandbox on a laptop stops when the laptop sleeps, like any other local tool. It is also new, and says so.",
            },
        ],
        verdict: [
            "If your code can sit on GitHub and on a vendor's VM, the cloud products are the least work, and on plans that already include them they cost nothing extra. Self-hosting is not automatically cheaper or more private: the model still sees the code.",
            "If the checkout or the keys must stay on your hardware, start with what you have: a machine that stays on, tmux and SSH. Add Remote Control if you use Claude and want the official app, or an open-source web UI if you want a browser and can secure it.",
            "If you want the whole cloud shape without the cloud (isolated parallel runs, a browser on any device, review before merge, triggers), that is what intentic is: an MIT-licensed workspace whose sandbox runs on your machine and keeps the repository and credentials there.",
        ],
        sections: [
            {
                heading: "What the cloud products actually give you",
                body: [
                    "Take away the interface and the cloud products are four things: a fresh VM per task, a setup step that installs your toolchain, a network policy, and a branch or pull request at the end. Claude Code on the web offers network levels from none to full, with a trusted default covering package registries and GitHub. Codex cloud makes internet access during the agent's work a switch you turn on, with presets.",
                    "Both keep going when your laptop closes, because nothing runs on your laptop. That is the property most people are buying, and the one a self-hosted setup has to reproduce first.",
                ],
            },
            {
                heading: "What self-hosting changes",
                body: [
                    "Self-hosting moves the agent, not the model. Everything below changes; what the provider sees does not.",
                ],
                points: [
                    "Where the code lives: the checkout and its history stay on a disk you control rather than a vendor VM.",
                    "Whose credentials: database passwords and deploy keys stay on your machine instead of going into a vendor's environment settings.",
                    "Subscriptions: the agent CLI signs in with the same Claude or ChatGPT plan, and turns draw on the same allowance either way.",
                    "Uptime: the machine has to be on. A desktop that sleeps at night is not a server.",
                    "The environment: any image, any toolchain, any internal host, and no time limit on setup.",
                ],
            },
            {
                heading: "Reaching it without opening it up",
                body: [
                    "The risk in self-hosting a web UI is the UI, not the agent. A port forwarded on your router, or a server bound to every interface on a VPS, hands a shell to whoever finds it.",
                    "Two patterns hold up. Keep the port private and reach it over SSH or a private network. Or use something that dials outward, as Remote Control, Happy's relay and intentic's tunnel all do, so nothing inbound is opened at all.",
                ],
            },
            {
                heading: "What you give up",
                body: [
                    "The vendor patches the VMs, keeps the image current, and runs as many sessions as your plan allows. There are official phone apps, and a session starts from anywhere with nothing of yours left running.",
                    "Self-hosting swaps all of that for a machine you maintain. For many people that is the right trade, because the repository or the keys cannot leave. For many others it is not, and the cloud product is the honest answer.",
                ],
            },
        ],
        faq: [
            {
                id: "self-hosted-claude-code-web-ui",
                question: "Is there a self-hosted web UI for Claude Code?",
                answer: "Yes. Open-source options include Claude Code UI (now called CloudCLI) and Happy, and OpenCode ships its own opencode web. Anthropic's Remote Control lets claude.ai drive a session on your machine. intentic is a fuller workspace around Claude Code and other agents, with its sandbox on your machine.",
            },
            {
                id: "codex-cloud-alternative",
                question: "What is a good alternative to Codex cloud?",
                answer: "If you want another hosted service, Claude Code on the web and Cursor's cloud agents are the peers. If the code has to stay on your hardware, run the Codex CLI on an always-on machine, using codex exec for unattended tasks, or use a self-hosted workspace such as intentic that runs Codex on your ChatGPT plan.",
            },
            {
                id: "self-host-same-subscription",
                question: "Can I self-host and still use my Claude or ChatGPT subscription?",
                answer: "Yes. The agent CLIs sign in with the same plan wherever they run, so a session on your server draws on the same allowance as one on your laptop. intentic connects your own subscriptions and never resells inference.",
            },
            {
                id: "self-hosted-more-private",
                question: "Is self-hosting more private than Claude Code on the web?",
                answer: "It changes who holds the checkout and the credentials, not who sees the conversation. The model provider still receives the files the agent reads. Self-hosting removes the vendor VM and the repository access grant; only a local model keeps the conversation on your machine.",
            },
            {
                id: "self-hosted-closed-laptop",
                question: "Will a self-hosted agent keep running when I close my laptop?",
                answer: "Only if it is not on the laptop. Put it on a desktop that stays awake, a home server or a VPS. A self-hosted tool on a sleeping laptop stops like any other process.",
            },
        ],
        related: [
            { label: "Where your code goes", href: guidesHref("where-your-code-goes-with-cloud-coding-agents") },
            { label: "Agents that persist", href: guidesHref("keep-a-coding-agent-running-after-you-close-your-laptop") },
            { label: "Host agent work", href: productHref("host") },
            { label: "Quickstart", href: docsHref("quickstart") },
            { label: "intentic vs cloud agents", href: compareHref("cloud-agents") },
            { label: "intentic vs Codex", href: compareHref("codex") },
        ],
        meta: {
            title: "A self-hosted alternative to Claude Code on the web",
            description:
                "What Claude Code on the web and Codex cloud actually do, what changes when you self-host the agent instead, and the self-hosted options that hold up in use.",
            datePublished: PUBLISHED_OCTOBER,
        },
    },
    {
        slug: "self-hosted-background-coding-agents",
        question: "How do you run coding agents in the background on your own hardware?",
        navLabel: "Background agents",
        blurb: "Decide what wakes the agent, where it runs, and where its work lands. Choosing the model is the easy part.",
        answer: "Put the agent on a machine that stays on, give it a trigger (a schedule, a webhook or an event), run each job in a fresh checkout or container, and have every run end as a branch you review rather than a merge. Cap what each run may spend before the first one fires, because nobody is watching when it does.",
        facts: [
            "A background agent is the same CLI run without a terminal. Claude Code's claude -p and Codex's codex exec take a task, work, print the result and exit, which is what a scheduler or a webhook handler needs.",
            "Defaults differ, so read them. codex exec runs in a read-only sandbox unless you pass --sandbox workspace-write. Claude Code in print mode runs the hooks in a project's .claude/settings.json even in a folder you never trusted, unless you pass --bare.",
            "Plain cron fires only if the machine is awake at that minute. A job scheduled for 3am on a laptop that is asleep at 3am simply does not run.",
            "Hosted versions exist for every major agent: Anthropic's and OpenAI's GitHub Actions run on GitHub runners, GitHub's Copilot cloud agent opens pull requests from assigned issues, and Cursor's cloud agents (formerly background agents) run in cloud VMs.",
            "Unattended runs spend with nobody watching. A run that fails every night fails every night, and on a subscription it draws on the same limits as your daytime work.",
        ],
        options: [
            {
                name: "cron and headless mode",
                what: "A crontab line on an always-on machine that creates a worktree and calls claude -p or codex exec with a fixed prompt.",
                goodFor: "One or two scheduled chores, such as a nightly dependency audit or a weekly changelog draft. It is free and you can read the whole system in one line.",
                breaksWhen:
                    "Runs overlap, several jobs want the same checkout, or you need to find out what happened last Tuesday. Logs, isolation and review are all yours to build.",
            },
            {
                name: "GitHub Actions",
                what: "anthropics/claude-code-action or openai/codex-action in a workflow, fired by a workflow event such as an @claude comment, a new issue, a pull request or a cron schedule.",
                goodFor: "Work whose triggers already live in GitHub. The runner, the branch and the pull request come with it.",
                breaksWhen:
                    "Triggers come from elsewhere (an alert, a payment, a chat message), or runs need services and state that outlive a job. GitHub-hosted runners also spend your Actions minutes; self-hosted runners avoid that by making you operate them.",
            },
            {
                name: "A hosted background agent",
                what: "GitHub's Copilot cloud agent, Codex cloud, Claude Code on the web or Cursor's cloud agents: assign a task, get a branch or pull request back.",
                goodFor: "Getting asynchronous work done with nothing to operate, for teams already paying for the product.",
                breaksWhen: "Code or keys must stay on your infrastructure, or the event you care about is not one the vendor can trigger on.",
            },
            {
                name: "A webhook receiver you write",
                what: "A small server that takes a POST from your monitoring or billing system and starts the agent CLI.",
                goodFor: "One precise trigger from a system you own, with logic no product would ship.",
                breaksWhen:
                    "The second week, when you are writing a queue, a concurrency limit, authentication, retries and somewhere to read the logs. That is a product, and now you maintain it.",
            },
            {
                name: "A self-hosted agent workspace",
                what: "intentic's automations wake an agent on a schedule, a webhook, a connected service's events or the sandbox's own events, each run in a fresh session and worktree on your machine.",
                goodFor:
                    "Triggers from several places in one view, every run on the board with its transcript, diff and cost, and nothing leaving your hardware.",
                breaksWhen: "You have one nightly job and a cron line would do. It also needs a machine that stays on, like everything else here.",
            },
        ],
        verdict: [
            "Start with the smallest setup that has all four parts: a machine that stays on, a trigger, a fresh checkout per run, and output that lands as a branch. A cron entry that calls the agent's headless mode in a new worktree is a legitimate first version.",
            "If the events already live in GitHub, the official Actions integrations are the shortest path, because the trigger, the runner and the pull request are there already.",
            "When triggers come from several systems and runs should stay on your machine, intentic covers it: automations on a schedule, a webhook, a service's events or the workspace itself, an optional guard command that skips runs with nothing to do, models chosen per automation, a spend ledger, and review before anything lands.",
        ],
        sections: [
            {
                heading: "Four parts, and the model is the least interesting",
                body: [
                    "Every background agent setup that holds up has the same four parts. The agent CLI is interchangeable between them; the parts around it are where setups fail.",
                ],
                points: [
                    "A trigger: what starts the run, and with what input.",
                    "A host: a machine that is awake when the trigger fires.",
                    "Isolation: a fresh checkout or container per run, so runs cannot trip over each other or over you.",
                    "A landing: where the result goes, which should be a branch someone reviews, never the default branch.",
                ],
            },
            {
                heading: "Pick the trigger by where the event already is",
                body: [
                    "A schedule suits chores that are worth doing whether or not anything happened: audits, reports, cleanup. A webhook suits systems that can send an HTTP request: monitoring, billing, a pipeline elsewhere. An event integration suits services the agent should listen to directly, such as a chat channel or a failing build.",
                    "Whatever the trigger, put a cheap check in front of it. A shell command that asks whether there is anything to do (is the queue empty, did the branch move, does yesterday's report exist) costs nothing, and a run that ends with nothing to do still cost a turn.",
                ],
            },
            {
                heading: "Isolate every run",
                body: [
                    "A background run should never work in a checkout you are using. Give each one a fresh worktree or container, so two runs that overlap, or one run and you, cannot overwrite each other.",
                    "Isolation is also what makes skipping permission prompts acceptable. Nobody is there to approve a command at 3am, so the boundary has to be the container and the credentials inside it, not a prompt. Keep those credentials scoped to the job: a token for one repository, a read-only database role.",
                ],
            },
            {
                heading: "Review before merge, every time",
                body: [
                    "Unattended work should produce a proposal, not a result. The run commits to its own branch and stops; a person reads the diff before anything merges. GitHub designed its Copilot cloud agent the same way: it pushes to its own branch and cannot push to your default branch.",
                    "Keep automatic merging off for unattended runs. Work held on a branch costs one click to release, while work that merged unread has to be noticed first, and the person who would have noticed was asleep.",
                ],
            },
            {
                heading: "Bound the cost before the first run",
                body: ["Spend is the one resource an unattended run cannot give back, so set the limits before anything fires."],
                points: [
                    "Cap each run, in dollars or turns, where your tooling allows it.",
                    "Pick the model per job: a cheaper model for triage and summaries, the strongest one only where the work needs it.",
                    "Skip no-op runs with a guard check rather than letting the agent discover there was nothing to do.",
                    "Let one run per trigger go at a time, so a retry storm cannot fan out.",
                    "Read the spend per run weekly. A job that quietly fails every night shows up there first.",
                ],
            },
        ],
        faq: [
            {
                id: "what-is-a-background-coding-agent",
                question: "What is a background coding agent?",
                answer: "A coding agent that runs without anyone at the keyboard: started by a schedule, a webhook or an event, working in its own checkout, and leaving its result as a branch or pull request to review later. The agent is the same CLI you use interactively, run in its non-interactive mode.",
            },
            {
                id: "claude-code-on-a-schedule",
                question: "Can Claude Code run on a schedule?",
                answer: "Yes. Call claude -p from cron or a CI schedule on a machine that is awake at that time, or use Anthropic's GitHub Action with a cron trigger. Anthropic also offers hosted Routines, a research preview, that run on a schedule, an API call or GitHub events.",
            },
            {
                id: "webhook-starts-agent",
                question: "Can a webhook start a coding agent?",
                answer: "Yes. Anything that can receive an HTTP request can start an agent CLI with the payload in its prompt. The hard parts are authentication, overlapping runs and logs, which is why most people use CI, a hosted agent, or a workspace with webhook triggers built in.",
            },
            {
                id: "unattended-agent-safe",
                question: "Is it safe to let a coding agent run unattended?",
                answer: "It is safe when the limits are set beforehand: an isolated checkout or container, credentials scoped to the job, a spend cap, and output that lands on a branch for review. Without those, an unattended agent can spend a lot and change a lot before anyone looks.",
            },
            {
                id: "background-agent-cost",
                question: "How do you stop a background agent from running up costs?",
                answer: "Cap each run, choose a cheaper model for routine jobs, skip runs with nothing to do using a guard check, and let only one run per trigger go at a time. Then read per-run spend weekly, because a job that fails every night shows up there before anywhere else.",
            },
        ],
        related: [
            { label: "Automations, in the docs", href: docsHref("automations") },
            { label: "Automate", href: productHref("automate") },
            { label: "Agents that persist", href: guidesHref("keep-a-coding-agent-running-after-you-close-your-laptop") },
            { label: "Reviewing agent work", href: guidesHref("review-ai-generated-code-changes") },
            { label: "intentic vs GitHub Copilot", href: compareHref("github-copilot") },
            { label: "intentic vs cloud agents", href: compareHref("cloud-agents") },
        ],
        meta: {
            title: "Self-hosted background coding agents: a setup guide",
            description:
                "Run coding agents in the background on your own hardware: schedule, webhook and event triggers, a fresh checkout per run, review before merge, capped spend.",
            datePublished: PUBLISHED_OCTOBER,
        },
    },
    {
        slug: "best-tools-for-running-parallel-coding-agents",
        question: "Which tools actually help you run coding agents in parallel?",
        navLabel: "Parallel agent tools",
        blurb: "Ten options, from plain worktrees to cloud agents, checked against each tool's own site in October 2026, with what each is best for and where it stops.",
        answer: "Choose by isolation first and interface second. Worktree tools such as Claude Squad, Conductor, Superset, Sculptor and Nimbalyst keep agents out of each other's files. Docker Sandboxes and intentic also separate processes, ports and credentials. Codex cloud, Claude Code on the web and Devin run on the vendor's machines. Plain git worktrees and tmux are still a valid answer.",
        facts: [
            "This roundup is as of October 2026, checked against each tool's own website, docs or repository. The category moves monthly: Windsurf is now called Devin Desktop, Docker Sandboxes moved to a standalone sbx command, and the company behind Vibe Kanban shut down in April 2026.",
            "Local tools run the agent CLIs you already pay for, such as Claude Code, Codex and Gemini CLI, on your own subscription. The cloud agents are the exception: each runs its own vendor's agent on the vendor's machines.",
            "Claude Code now creates worktrees itself: claude --worktree with a name puts the session in its own checkout under .claude/worktrees on its own branch. For two or three agents, that may be all the tooling you need.",
        ],
        options: [
            {
                name: "git worktree and tmux, by hand",
                what: "One git worktree add per agent, one tmux window per agent. Free, and already on any machine with git.",
                goodFor: "Two to four agents on one machine, for anyone comfortable in a terminal. Nothing new to install or trust.",
                breaksWhen:
                    "Agents need to run the app: ports, databases and installed tools are shared. There is no view of which agent is waiting on you, and nothing survives the machine sleeping.",
            },
            {
                name: "Claude Squad",
                what: "Open-source terminal app (AGPL-3.0) that gives each agent a tmux session and a git worktree. Runs Claude Code by default, plus Codex, Gemini, Aider or any command.",
                goodFor: "The worktree and tmux recipe with the bookkeeping done for you, without leaving the terminal. Builds exist for macOS and Linux.",
                breaksWhen:
                    "Agents collide on ports or services, since the isolation is worktrees. Windows needs tmux through WSL, and the agents live on one machine, reachable only from its terminal.",
            },
            {
                name: "Conductor",
                what: "Mac app that runs Claude Code, Codex, Cursor and OpenCode in parallel, each in its own worktree, with review built in. Free tier; Pro is $50 a month.",
                goodFor: "Mac users who want a polished interface built for this, plus the option of Pro cloud workspaces that keep running after the app closes.",
                breaksWhen:
                    "You are not on a Mac. Its own docs note that worktrees are not a security boundary: local agents run on your Mac with your user permissions.",
            },
            {
                name: "Superset",
                what: "Desktop app and CLI giving any CLI agent its own worktree, terminals and diff. Source-available (Elastic License 2.0); the desktop app is free, Pro is $20 per user a month.",
                goodFor: "Many agents at once with a preview port per worktree, and reaching workspaces on another connected machine, including from an iPhone with Pro.",
                breaksWhen: "You need Windows, which is not yet available, or first-class Linux, which is an experimental AppImage.",
            },
            {
                name: "Sculptor",
                what: "Imbue's MIT-licensed desktop app: each agent gets its own worktree, branch, terminal and diff, on your Claude plan. macOS (Apple Silicon) and Linux, labelled beta.",
                goodFor: "Claude users who want a free, open-source desktop app and are comfortable with beta software.",
                breaksWhen:
                    "You need Windows, or agents beyond Claude, which come only through experimental Pi agent support. Earlier versions ran each agent in a container; the current product page describes worktrees.",
            },
            {
                name: "Nimbalyst",
                what: "MIT-licensed desktop app for macOS, Windows and Linux, with an iOS companion, that pairs Claude Code and Codex with visual editors for documents, diagrams and mockups.",
                goodFor: "Work that is as much specs, diagrams and mockups as code, on whichever desktop OS you use. Free for individuals.",
                breaksWhen: "You want isolation by default: a worktree per session is opt-in. It is a local desktop app, not an always-on server.",
            },
            {
                name: "Vibe Kanban",
                what: "Apache-2.0 kanban board, started with npx vibe-kanban, that runs a long list of agent CLIs in worktrees with setup scripts.",
                goodFor: "A task board in front of local agents, if you are fine running community-maintained software.",
                breaksWhen:
                    "You want a company behind the tool. Its maker shut down in April 2026, the README says the project is sunsetting, and the last tagged release is from that month.",
            },
            {
                name: "Docker Sandboxes",
                what: "Docker's sbx CLI runs an agent in a microVM with its own Docker daemon, filesystem and network, locally or in Docker's cloud. Supports Claude Code, Codex, Copilot, Gemini, OpenCode and more.",
                goodFor:
                    "Isolation well beyond a worktree, including Docker inside the sandbox. Local use is free on macOS (Apple silicon), Windows 11 and Ubuntu 24.04 or later.",
                breaksWhen:
                    "You want a board, a review queue or several agents managed together: it is the isolation layer, not the workflow. Cloud sandboxes are pay-as-you-go and expire on a time-to-live.",
            },
            {
                name: "Cloud agents",
                what: "Codex cloud, Claude Code on the web and Devin run each task on the vendor's infrastructure, in a VM for the first two, and hand back a diff or pull request.",
                goodFor:
                    "Parallel work with nothing to operate, started from a browser or phone, running while your laptop sleeps. Included from ChatGPT Plus (Codex) and Claude Pro (Claude Code).",
                breaksWhen:
                    "Code or keys must stay on your infrastructure, your repository is not on GitHub (Codex cloud supports only GitHub so far), or you want several vendors' agents in one place. Cloud tasks also draw down the same plan allowance as your local work.",
            },
            {
                name: "intentic",
                what: "MIT-licensed workspace: a Docker sandbox on your laptop, desktop or VPS, a git worktree per agent inside it, reached from any browser. Runs Claude Code, Codex, Grok, Kimi Code and Gemini on your own accounts.",
                goodFor:
                    "Agents that keep running on a machine you own after the browser closes, with a board of who needs you, plan mode, per-hunk review and automations.",
                breaksWhen:
                    "You want a native desktop app or zero setup. Agents in one sandbox share its environment, so different tools or credentials mean separate sandboxes. It is new, and says so.",
            },
        ],
        verdict: [
            "If you have not tried plain worktrees yet, start there, or with Claude Code's own --worktree flag. You will soon know whether your problem was file collisions, which they solve, or something else.",
            "If you want an interface on one machine, choose by platform and licence: Conductor on a Mac, Nimbalyst on any desktop OS, Superset or Sculptor on a Mac or Linux, Claude Squad anywhere tmux runs.",
            "If agents need to run the app, install packages or hold credentials, move to container isolation: Docker Sandboxes for the boundary alone, or a workspace with a board and review on top, such as intentic, when runs must keep going on hardware you own. If you would rather operate nothing, a cloud agent is the honest answer.",
        ],
        sections: [
            {
                heading: "Sort the tools by isolation, not by interface",
                body: [
                    "The interfaces in this list look alike: a sidebar of agents, a diff, a terminal. What differs is what each agent is kept away from, and that decides which problems you still have after installing it. Each level up removes a class of collision and adds setup.",
                ],
                points: [
                    "Files: a worktree per agent. Claude Squad, Conductor, Superset, Sculptor, Nimbalyst, Vibe Kanban and plain git.",
                    "Environment: a container or microVM per agent or per workspace, with its own processes, ports and installed tools. Docker Sandboxes and intentic.",
                    "Machine: a VM on someone else's infrastructure per task. Codex cloud, Claude Code on the web, Devin, and Conductor's cloud workspaces.",
                ],
            },
            {
                heading: "What every worktree tool shares, and where it stops",
                body: [
                    "A worktree tool removes the collision that bites first: two agents writing the same file. It does nothing about the next one. Two agents that both start a dev server want the same port, two test runs share one database, and every worktree uses the same installed language versions and global packages.",
                    "Some tools soften this: Superset detects ports per workspace, and Vibe Kanban runs a setup script for each new worktree. None of them turn a worktree into a separate machine. Superset's README says it plainly: worktrees separate working files; they do not sandbox processes.",
                ],
            },
            {
                heading: "Where the agents run decides whether they keep going",
                body: [
                    "A desktop app runs agents on the computer it is installed on, so closing the lid stops them. Conductor Pro and the cloud agents get around that on vendor infrastructure; Superset reaches workspaces on another machine you connect. intentic runs the sandbox wherever you start it, so it keeps going on a desktop or VPS and stops on a laptop you close.",
                ],
            },
            {
                heading: "Price and licence, side by side",
                body: [
                    "Open-source options: Claude Squad (AGPL-3.0), Sculptor, Nimbalyst and intentic (MIT), and Vibe Kanban (Apache-2.0). Superset publishes its source under the Elastic License 2.0, which is not an OSI licence. Conductor and Devin are commercial products with free tiers.",
                    "With every local tool, model usage comes out of your own provider subscription. Cloud agents spend the same allowance: OpenAI notes that cloud tasks may use more of it than local messages.",
                ],
            },
        ],
        faq: [
            {
                id: "best-tool-parallel-claude-code",
                question: "What is the best tool for running parallel Claude Code agents?",
                answer: "It depends on what is colliding. For file collisions, Claude Code's own --worktree flag or Claude Squad is enough. For a desktop interface, Conductor on a Mac or Sculptor and Nimbalyst elsewhere. When agents need separate environments or must keep running on your own machine, use a container-based option such as Docker Sandboxes or intentic.",
            },
            {
                id: "claude-code-orchestrator",
                question: "Is there an orchestrator for Claude Code?",
                answer: "Several. Claude Squad, Conductor, Superset, Sculptor, Nimbalyst and intentic all start and track several Claude Code sessions, each in its own checkout. Claude Code also runs subagents and worktree sessions itself, so check whether the built-in features already cover your case before adding a tool.",
            },
            {
                id: "worktrees-enough",
                question: "Do I need a tool at all, or are git worktrees enough?",
                answer: "Worktrees are enough while the agents only edit files. A tool earns its place when you lose track of which agent needs you, or when agents start running servers, databases or installs that collide. The first is an interface problem; the second needs containers.",
            },
            {
                id: "open-source-parallel-agent-tools",
                question: "Which parallel coding agent tools are open source?",
                answer: "As of October 2026: Claude Squad (AGPL-3.0), Sculptor, Nimbalyst and intentic (MIT), and Vibe Kanban (Apache-2.0). Superset's source is public under the Elastic License 2.0, which is source-available rather than open source. Conductor, Devin and the hosted cloud agents are not open source.",
            },
            {
                id: "parallel-agents-windows",
                question: "Which of these tools work on Windows?",
                answer: "Nimbalyst ships a Windows desktop app, Docker Sandboxes supports Windows 11, and intentic runs its sandbox in Docker through WSL2. Claude Squad needs tmux through WSL. Conductor is Mac-only, Superset has no Windows build yet, and Sculptor supports macOS and Linux only. Cloud agents work from any browser.",
            },
        ],
        related: [
            { label: "Running agents in parallel", href: guidesHref("run-multiple-coding-agents-in-parallel") },
            { label: "Claude Code in a Docker sandbox", href: guidesHref("run-claude-code-in-a-docker-sandbox") },
            { label: "Parallel agents, in the docs", href: docsHref("parallel-agents") },
            { label: "intentic vs Conductor", href: compareHref("conductor") },
            { label: "intentic vs Superset", href: compareHref("superset") },
            { label: "intentic vs Nimbalyst", href: compareHref("nimbalyst") },
            ...compareLink("claude-squad", "intentic vs Claude Squad"),
            ...compareLink("sculptor", "intentic vs Sculptor"),
            ...compareLink("vibe-kanban", "intentic vs Vibe Kanban"),
            ...compareLink("docker-sandboxes", "intentic vs Docker Sandboxes"),
        ],
        meta: {
            title: "Best tools for running parallel coding agents (2026)",
            description:
                "An honest roundup as of October 2026: worktree apps, container sandboxes and cloud agents for running coding agents in parallel, with the limits of each.",
            datePublished: PUBLISHED_OCTOBER,
        },
    },
];

export const guidePage = (slug: string): GuidePage | undefined => guidePages.find((page) => page.slug === slug);
