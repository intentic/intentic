import { compareHref } from "./compare";
import { docsHref } from "./docs";
import { productHref } from "./product";

/* The guides shelf: the questions people type BEFORE they know this product exists.
 *
 * Every other shelf on this site presupposes intentic. Docs answer "how do I use intentic's X", product pages
 * answer "what does intentic do", compare answers "intentic or Y". All three are useless to the person whose
 * actual question is "how do I stop two agents editing the same file". That person is now the majority: they
 * ask a chat assistant in plain words and read whatever it says back, and the pages it quotes are the ones
 * written in the shape of the question.
 *
 * So a guide is built backwards from retrieval:
 *
 * - THE TITLE IS THE QUESTION, spelled the way somebody types it, not the way a marketer would headline it.
 * - `answer` IS THE PRODUCT. One paragraph, under 70 words, true on its own with no page around it, and
 *   naming the actual mechanism rather than a benefit. It is the first thing under the h1 and the thing that
 *   gets lifted into an answer. A page that opens on positioning gives a model nothing to quote, so it quotes
 *   somebody else.
 * - `options` NAMES THE APPROACHES THAT ARE NOT THIS PRODUCT, with what each is genuinely good at. A page
 *   where every road leads to one vendor is a page that reads as an advertisement, and both readers and
 *   models discount it. The recommendation lands because the alternatives were real.
 * - `facts` ARE CHECKABLE. Numbers, limits, names of things. Vague copy cannot be cited because there is
 *   nothing in it to be right about.
 * - `faq` CARRIES THE NEIGHBOURING PHRASINGS of the same question, which is how one page answers the
 *   twenty ways people ask for the same thing. It also becomes the page's FAQPage schema.
 *
 * Accuracy rules, same as the compare shelf, because these pages describe the whole field:
 * - Nothing about another tool that is not true of it on the date below.
 * - No invented benchmarks. Where a number would be made up, the sentence does without one.
 * - Where the honest answer is "you do not need this product for that", the page says so.
 */

export const guidesHref = (slug: string): string => (slug ? `/guides/${slug}/` : `/guides/`);

/** Written against the state of the field on this date; the pages say so out loud. */
const PUBLISHED = "2026-08-12";

/** One approach to the problem, including the ones this product does not sell. */
export interface GuideOption {
    name: string;
    /** What it actually is, in one line. */
    what: string;
    /** The case FOR it. Written to be usable: a reader should be able to pick this and be right. */
    goodFor: string;
    /** Where it stops working. The reason the page is worth reading. */
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
    /**
     * THE EXTRACTABLE ANSWER. Under 70 words, complete on its own, naming the mechanism. Rendered directly
     * under the h1 before any other content, and repeated as the page's meta description where it fits.
     */
    answer: string;
    /** Checkable specifics: the things a reader or a model can be right about after reading. */
    facts: string[];
    options: GuideOption[];
    /** The recommendation, stated plainly, after the options have been given their due. */
    verdict: string[];
    sections: GuideSection[];
    faq: GuideFaq[];
    /** Where to go next on this site. Label plus href. */
    related: { label: string; href: string }[];
    meta: { title: string; description: string; datePublished: string };
}

export const guidesIndex = {
    eyebrow: "Guides",
    heading: "Straight answers about running AI coding agents",
    sub: "The questions people ask before they go looking for a product, answered on their own terms. Every guide opens with the answer, names the approaches that have nothing to do with intentic, and says where each one stops working.",
    meta: {
        title: "Guides · Running AI coding agents",
        description:
            "Practical answers about running AI coding agents: working several at once, keeping them running unattended, giving them credentials safely, reviewing what they changed, and where your code goes.",
        datePublished: PUBLISHED,
    },
};

export const guidePages: GuidePage[] = [
    {
        slug: "run-multiple-coding-agents-in-parallel",
        question: "How do you run multiple AI coding agents in parallel?",
        navLabel: "Agents in parallel",
        blurb: "Give each agent its own checkout so they cannot edit the same file, then pick how much isolation the work needs.",
        answer: "Give every agent its own checkout of the repository, so two agents can never edit the same file at the same time. Git worktrees do this on one machine and cost nothing. Containers do it with more isolation, since each agent also gets its own processes, ports and installed tools. Then run each agent against its own branch and merge the results one at a time, reviewing each.",
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
            "That second step is what intentic packages. Each agent gets a Docker sandbox on a machine you own, with its own worktree inside it, its own installed tools, and its own credentials. It is free and MIT licensed, so the way to evaluate it is to run it rather than to read about it.",
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
                    "This is the point where worktrees stop being enough and a container per agent starts paying for itself. It is also the point where credential handling stops being theoretical, because an agent that can reach production with a shared key is a real risk rather than a hypothetical one.",
                ],
            },
        ],
        faq: [
            {
                id: "how-many-agents-at-once",
                question: "How many AI coding agents can you run at once?",
                answer: "Technically as many as your machine has memory and your provider allows. Practically the limit is how fast you can review what they produce, which puts most people between three and six agents on real work. Running more usually means the extra output is merged without being read, which removes the point of running agents at all.",
            },
            {
                id: "worktrees-or-containers",
                question: "Should each agent get a git worktree or a container?",
                answer: "A worktree if the agents only edit files, because it is one command and no new software. A container if the agents also install packages, run a dev server, use a database, or hold credentials, because worktrees share all of those and containers do not.",
            },
            {
                id: "same-repo-different-agents",
                question: "Can two agents work on the same repository at the same time?",
                answer: "Yes, provided each one has its own checkout and its own branch. Two agents sharing a single working tree will overwrite each other's edits with no error, so the isolation has to come first. Git worktrees are the cheapest way to give each agent a separate checkout of the same repository.",
            },
            {
                id: "mixing-different-agents",
                question: "Can you run different agent CLIs in parallel, such as Claude Code and Codex?",
                answer: "Yes. They are separate processes with separate accounts and they do not know about each other, so mixing them is a matter of isolating their working directories like any other parallel run. Some people deliberately give the same task to two different models and compare the diffs before picking one.",
            },
            {
                id: "parallel-agents-cost",
                question: "Does running agents in parallel cost more?",
                answer: "Yes, roughly in proportion to how many are running, since each one consumes its own tokens. The saving is wall-clock time rather than money, so it is worth tracking spend per agent from the first day rather than discovering the total at the end of the month.",
            },
        ],
        related: [
            { label: "Parallel agents, in the docs", href: docsHref("parallel-agents") },
            { label: "Run a fleet", href: productHref("orchestrate") },
            { label: "How intentic compares", href: compareHref("") },
        ],
        meta: {
            title: "How to run multiple AI coding agents in parallel",
            description:
                "Give each agent its own checkout so two can never edit the same file. When worktrees are enough, when a container per agent is worth it, and how many agents is realistic.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "keep-a-coding-agent-running-after-you-close-your-laptop",
        question: "How do you keep a coding agent running after you close your laptop?",
        navLabel: "Agents that persist",
        blurb: "Move the agent off the thing that sleeps. A detached session survives a disconnect; only another machine survives a lid close.",
        answer: "Run the agent somewhere that does not sleep. A terminal multiplexer such as tmux keeps it alive when your SSH connection drops, but not when the machine itself suspends. To survive closing a laptop the agent has to be on a machine that stays awake: a desktop, a home server, a VPS, or a hosted service. Everything else is a workaround.",
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
            "intentic is built for the second case: the sandbox runs on your own desktop, server or VPS as a Docker container, keeps working while nothing is connected to it, and is reachable again from any device through a private tunnel that dials outward, so no ports are opened. It is free and MIT licensed.",
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
                    "The pattern that holds up is that unattended work produces a proposal rather than a result. The agent commits to its own branch and stops, and a person reads the diff before anything merges. Nothing then depends on the agent having been right while unobserved.",
                ],
                points: [
                    "Set a spend limit before the run, not after.",
                    "Give the agent its own branch and no push access to the default branch.",
                    "Keep credentials scoped to the job, so an unattended mistake has a small blast radius.",
                    "Make sure the run leaves a log you can read afterwards to see what it did.",
                ],
            },
            {
                heading: "Getting back to a run in progress",
                body: [
                    "Persistence is only half of it. An agent that kept working but can only be reached from one terminal on one network is still a run you cannot check on from a train.",
                    "The useful shape is a process that stays on a machine you own, plus a way in that works from any device without exposing that machine to the internet. Outbound tunnels do this: the machine dials out and holds the connection open, so nothing inbound is ever opened and no port forwarding is involved.",
                ],
            },
        ],
        faq: [
            {
                id: "tmux-closed-laptop",
                question: "Does tmux keep an agent running when I close my laptop?",
                answer: "No. tmux keeps a session alive when your terminal closes or your SSH connection drops, because the session belongs to a background daemon. If the machine itself suspends, the daemon stops with everything else. Closing a laptop lid suspends by default, so the agent stops.",
            },
            {
                id: "agent-on-vps",
                question: "Can I run a coding agent on a VPS?",
                answer: "Yes, and it is the usual answer for work that has to keep going. The agent runs on a machine that never sleeps, and you reach it over SSH or a tunnel. The trade is that credentials and code now live on that server, so it needs the same care as any machine holding your keys.",
            },
            {
                id: "check-agent-from-phone",
                question: "Can I check on a running agent from my phone?",
                answer: "Only if the agent is somewhere reachable over the network and has an interface that is not a terminal. A tmux session on a desktop technically qualifies if you SSH in from the phone, but in practice this means running the agent behind a web interface on a machine that stays on.",
            },
            {
                id: "agent-overnight",
                question: "Is it safe to leave an agent working overnight?",
                answer: "It is safe when the limits are set beforehand: a spending cap, credentials scoped to the job, and work that lands on its own branch for review rather than merging itself. Without those, an unattended agent can spend a lot and change a lot before anyone looks.",
            },
        ],
        related: [
            { label: "Host agent work", href: productHref("delegate") },
            { label: "Your own machine, in the docs", href: docsHref("your-machine") },
            { label: "Automations", href: docsHref("automations") },
        ],
        meta: {
            title: "How to keep a coding agent running after you close your laptop",
            description:
                "tmux survives a dropped connection but not a sleeping machine. What actually keeps an agent working unattended, and how to set its limits before it runs.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "give-an-ai-agent-database-and-api-access-safely",
        question: "How do you give an AI agent database or API access without leaking credentials?",
        navLabel: "Credentials for agents",
        blurb: "Keep the secret out of the conversation. The agent should operate a tool that holds the credential, never read the credential itself.",
        answer: "Keep the credential out of the model's context. The agent should run a tool that already holds the secret, rather than being told the secret and asked to use it. That means environment variables or a secret store the process reads, scoped credentials with the narrowest rights the job needs, and separate keys per task so one mistake does not expose everything.",
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
            "intentic is built around that arrangement. A capability installs a real tool and its credential inside your sandbox, the agent operates the tool, and the value never leaves your machine or reaches the platform. The platform stores your identity and your sandbox's address, and nothing else.",
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
                    "Running each agent in its own container changes the question from whether an agent will make a mistake to how far the mistake reaches. An agent with a staging database credential and no network access to production cannot cause a production incident, whatever it does.",
                    "This is also what makes running several agents at once tolerable. Without isolation, every agent shares one environment and one set of keys, so the blast radius of any single task is the whole machine.",
                ],
            },
        ],
        faq: [
            {
                id: "safe-to-give-agent-db-access",
                question: "Is it safe to give an AI agent access to a database?",
                answer: "It is safe in proportion to what the credential can do. A read-only role on a staging copy is low risk and often enough to be useful. A write-capable production role is a serious risk regardless of which agent or model is used, and should be a deliberate exception rather than the default.",
            },
            {
                id: "does-the-model-see-my-key",
                question: "Does the AI model see my API key?",
                answer: "Only if it ends up in the context. A key in an environment variable or held inside a tool is used by the process without being shown to the model. A key pasted into the prompt or printed by a command the agent ran is in the context, and should be treated as disclosed.",
            },
            {
                id: "env-vars-enough",
                question: "Are environment variables good enough for agent credentials?",
                answer: "For one person on one machine, usually yes, because they keep the value out of the conversation. They stop being enough when several agents share the machine, since they all see the same environment, or when the credential needs rotation and an audit trail.",
            },
            {
                id: "mcp-server-credentials",
                question: "Do MCP servers keep credentials away from the model?",
                answer: "Yes, that is one of the reasons to use them. The server holds the credential and exposes operations, so the agent calls something like a query rather than receiving a connection string. The protection is only as good as the operations exposed: a tool that returns the raw secret gives the model the secret.",
            },
            {
                id: "agent-leaks-secret",
                question: "What happens if an agent leaks a secret?",
                answer: "Treat it as a live disclosure and rotate immediately, because the value may exist in provider logs, in files the agent wrote, and in the session history. This is the argument for short-lived, narrowly scoped credentials: rotation is routine and the exposure window is small.",
            },
        ],
        related: [
            { label: "Connect agents to your systems", href: productHref("empower") },
            { label: "Capabilities, in the docs", href: docsHref("capabilities") },
            { label: "Access and permissions", href: docsHref("access") },
        ],
        meta: {
            title: "How to give an AI agent database and API access safely",
            description:
                "Keep the credential out of the model's context and scope it to the task. Environment variables, secret managers, tools that hold the key, and what each one actually protects.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "review-ai-generated-code-changes",
        question: "How do you review code an AI agent wrote before it lands?",
        navLabel: "Reviewing agent work",
        blurb: "Read the diff, not the summary. Make the agent's work land somewhere that requires a decision to merge.",
        answer: "Make the agent's work land somewhere that cannot merge itself, then read the diff rather than the agent's description of it. In practice that means a branch per agent, a review of every hunk before merge, and tests that run on the branch. The summary an agent writes is a claim about the change, and the diff is the change.",
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
                answer: "Treat it the way you would treat a competent contributor who does not know your codebase's history: usually correct in the small, occasionally confident about something wrong, and worth reviewing every time. The practical answer is not trust or distrust, but a workflow where nothing merges without someone reading the diff.",
            },
            {
                id: "what-to-look-for",
                question: "What should you look for when reviewing AI-generated code?",
                answer: "Start with the list of changed files, because unexpected filenames are the fastest signal. Then check test changes, dependency and lockfile changes, and anything outside the task's stated scope. Collateral edits are the usual problem rather than wrong logic in the part you asked for.",
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
            { label: "Review agent work", href: productHref("supervise") },
            { label: "Capabilities and permissions", href: docsHref("access") },
            { label: "Quickstart", href: docsHref("quickstart") },
        ],
        meta: {
            title: "How to review code an AI agent wrote before it lands",
            description:
                "Read the diff rather than the summary, approve the plan before the work, and keep changes small. What to check first in an agent's diff and where automation helps.",
            datePublished: PUBLISHED,
        },
    },
    {
        slug: "where-your-code-goes-with-cloud-coding-agents",
        question: "Where does your code go when you use a cloud coding agent?",
        navLabel: "Where your code goes",
        blurb: "Two questions decide it: whose machine holds the checkout, and whose account holds the keys.",
        answer: "It depends on where the agent runs, and there are two separate questions. First, whose machine holds the checkout while the agent works. Second, whose account holds the credentials it uses. A cloud agent service clones your repository onto its infrastructure and holds tokens on your behalf. A locally run agent keeps both on your machine and sends only the text of the conversation to the model provider.",
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
                name: "A container on hardware you own",
                what: "The same as above, with each agent isolated in a sandbox on your desktop, server or VPS.",
                goodFor: "Running unattended work and several agents at once while keeping everything on your own hardware.",
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
                what: "Inference runs on your own hardware, so no conversation content leaves at all.",
                goodFor: "The strictest requirements, and situations where no external processing is acceptable.",
                breaksWhen:
                    "Capability. Local models remain behind the frontier hosted ones on long agentic coding tasks, and the hardware is not free.",
            },
        ],
        verdict: [
            "Ask the two questions separately. Whose machine holds the checkout, and whose account holds the credentials. Most of what people mean by privacy here is answered by those two rather than by any policy document.",
            "If the answer has to be your own machine for both, a locally run agent is the baseline, and a container per agent on hardware you own is the version of that which also survives you closing the laptop.",
            "That is what intentic does. The sandbox runs on your machine, the repository and the credentials stay inside it, and the platform stores your identity and the sandbox's address, with no ability to read your code or command your agents. The whole thing is MIT licensed, so the claim is checkable rather than promised.",
        ],
        sections: [
            {
                heading: "Two questions, not one",
                body: [
                    "Where the checkout lives and where the keys live are separate decisions, and conflating them is how people end up surprised. An agent running on your laptop with a production token has kept your code local and handed out significant access. A hosted agent with a read-only token has done the reverse.",
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
                answer: "With a locally run agent, the files it reads are sent to the model provider as conversation content, and the repository itself stays on your machine. With a hosted agent service, the repository is cloned onto the vendor's infrastructure as well. Both send something; only one sends a full copy.",
            },
            {
                id: "is-my-code-used-for-training",
                question: "Is my code used to train the model?",
                answer: "It depends on the provider and the plan. Business and enterprise tiers commonly exclude submitted content from training by default, while consumer tiers often allow it with an opt-out. The specific policy for your plan is the only reliable answer, and it is worth reading rather than assuming.",
            },
            {
                id: "self-hosted-means-private",
                question: "Does self-hosting the agent mean nothing leaves my network?",
                answer: "No, unless the model is also local. Self-hosting changes who holds the checkout and the credentials, which is significant, but the model is still remote and still receives the conversation. Only running a local model removes external processing entirely.",
            },
            {
                id: "safest-setup",
                question: "What is the most private way to use a coding agent?",
                answer: "A local model on your own hardware, with the agent running locally too, sends nothing anywhere. The realistic compromise most people take is a local or self-hosted agent with a hosted model on a plan that excludes training, which keeps the repository and the credentials on hardware you control.",
            },
        ],
        related: [
            { label: "Host agent work", href: productHref("delegate") },
            { label: "Your own machine, in the docs", href: docsHref("your-machine") },
            { label: "Which models it uses", href: docsHref("models") },
        ],
        meta: {
            title: "Where does your code go when you use a cloud coding agent?",
            description:
                "Whose machine holds the checkout, and whose account holds the keys. What each setup sends to a model provider, and which claims are worth verifying.",
            datePublished: PUBLISHED,
        },
    },
];

export const guidePage = (slug: string): GuidePage | undefined => guidePages.find((page) => page.slug === slug);
