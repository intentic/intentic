import type { FaqEntry } from "./structured-data";

// Plain-language comparisons. Keep competitor strengths, qualify deployment/model claims,
// and update each verifiedOn date only after opening every retained official source.
// Search priorities and their visible answers are recorded in docs/marketing/comparison-search-research.md.
export const compareHref = (slug: string): string => (slug ? `/compare/${slug}/` : `/compare/`);

const PUBLISHED = "2026-08-09";

export interface CompareFamily {
    id: string;
    label: string;
    verdict: string;
    body: string;
    examples: string[];
}

export interface CompareRow {
    label: string;
    intentic: string;
    them: string;
    /** A genuine reason to prefer the other product, not a numerical score. */
    theirs?: boolean;
}

export interface CompareSection {
    title: string;
    body: string;
}

export interface ComparePage {
    slug: string;
    name: string;
    url: string;
    navLabel: string;
    menuBlurb: string;
    family: string;
    heading: string;
    sub: string;
    /** A factual summary, not a quotation attributed to the vendor. */
    theirPitch: string;
    verdict: string[];
    overlap: CompareSection;
    differences: CompareSection[];
    table: CompareRow[];
    together?: CompareSection;
    pickThem: string;
    faq: FaqEntry[];
    /** Official pages actually opened for this revision. */
    sources: { label: string; url: string }[];
    /** Source-review date; distinct from publication and git modification dates. */
    verifiedOn: string;
    meta: { title: string; description: string; datePublished: string };
}

export const compareFamilies: CompareFamily[] = [
    {
        id: "harnesses",
        label: "Coding agents and CLI tools",
        verdict: "run them in intentic",
        body: "Claude Code, Codex and OpenCode can read a repository, edit files and run tests. intentic gives supported agents a shared browser workspace, separate Git worktrees and a review step before their changes reach your main checkout. You keep the agent rather than replace it.",
        examples: ["Claude Code", "Codex", "OpenCode", "Gemini CLI", "Kimi Code"],
    },
    {
        id: "editors",
        label: "AI code editors and Copilot",
        verdict: "keep your editor",
        body: "Cursor and GitHub Copilot help you write code inside an editor and also offer agent workflows. intentic is useful when you want to manage tasks across agents and machines. It is not a replacement for inline autocomplete or every feature of your IDE.",
        examples: ["Cursor", "GitHub Copilot", "Zed", "JetBrains AI"],
    },
    {
        id: "assistants",
        label: "Self-hosted AI assistants",
        verdict: "compare the workflow",
        body: "OpenClaw and Hermes Agent combine memory, messaging and tools. They can code too. intentic focuses on repository tasks, separate working branches and reviewing changes. Choose by the job you need done, not by whether a product calls itself an assistant or an agent.",
        examples: ["OpenClaw", "Hermes Agent", "Khoj"],
    },
    {
        id: "orchestrators",
        label: "Multi-agent coding workspaces",
        verdict: "the closest alternatives",
        body: "Conductor, Superset, T3 Code, Synara and Nimbalyst put multiple coding agents in one interface. Several already offer remote access, mobile clients or automations. Compare operating systems, licences, running costs and how each tool manages machines and reviews.",
        examples: ["Conductor", "Superset", "T3 Code", "Synara", "Nimbalyst"],
    },
    {
        id: "cloud",
        label: "Cloud coding agents",
        verdict: "managed or self-hosted",
        body: "Devin, Jules and other cloud agents can work while your laptop is off. intentic can do the same on an always-on machine you run or rent. Managed services handle more setup; self-hosting gives you more infrastructure choice. Some cloud products also support customer-hosted workers.",
        examples: ["Devin", "Google Jules", "Codex cloud", "Claude Code on the web", "Cursor cloud agents", "Replit Agent"],
    },
];

export const comparePages: ComparePage[] = [
    {
        slug: "conductor",
        name: "Conductor",
        url: "https://www.conductor.build/",
        navLabel: "intentic vs Conductor",
        menuBlurb: "A free, open-source Conductor alternative for browser-managed work on your own machines.",
        family: "orchestrators",
        heading: "Conductor vs intentic: a free, open-source alternative",
        sub: "Compare Conductor pricing, Windows and Linux support, cloud workspaces and remote access. Conductor here means the coding app at conductor.build.",
        theirPitch: "Conductor is a Mac app for running coding agents in parallel, with separate worktrees, code review and optional managed cloud workspaces.",
        verdict: [
            "Choose Conductor for a focused Mac workflow and managed cloud execution. Choose intentic for an MIT-licensed workspace you can run on your own hardware and access in a browser.",
            "Conductor's local app is free too. The difference is not free versus paid AI: both use your agent accounts, and model usage can cost money.",
        ],
        overlap: { title: "Both manage parallel coding agents", body: "Both separate tasks with Git worktrees and let you inspect changes. A worktree is a separate branch and directory, not a security sandbox or a promise of conflict-free merging." },
        differences: [
            { title: "Mac app or browser workspace", body: "Conductor's desktop app requires macOS. intentic's browser interface works from Windows, macOS and Linux; its sandbox runs on a supported Docker host. You can use a server instead of keeping a development laptop open." },
            { title: "Pricing: local work and cloud work", body: "Conductor is free locally. Pro is $50/month; Teams is $60/user/month and currently invite-only. intentic is free to self-host, including sharing and automations. AI usage and optional hosted machines are separate costs." },
            { title: "Managed cloud or your own machine", body: "Conductor Cloud keeps working after the Mac app closes. intentic runs work on the machine you choose. Both offer automation; Conductor documents webhook routines and other trigger types. Neither makes an offline laptop run jobs." },
        ],
        table: [
            { label: "Licence", intentic: "MIT; free to self-host and modify", them: "Proprietary app with a free local tier" },
            { label: "Operating systems", intentic: "Browser on Windows, macOS and Linux; Docker host", them: "macOS desktop; Windows and Linux not yet supported" },
            { label: "Local pricing", intentic: "Free software; AI usage separate", them: "$0 desktop tier; AI usage separate" },
            { label: "Cloud execution", intentic: "Your always-on machine or optional hosted sandbox", them: "Managed Conductor Cloud on paid plans", theirs: true },
            { label: "Review workflow", intentic: "Review and land changes in a shared browser workspace", them: "Focused Mac interface for reviewing and merging parallel work", theirs: true },
            { label: "Remote access", intentic: "Browser access to your workspace", them: "Phone app and collaboration on paid plans" },
        ],
        pickThem: "Pick Conductor if you work on a Mac and want a polished, purpose-built interface for parallel agents. Its managed cloud, phone access and collaboration are good reasons to pay if you would rather not maintain an always-on host.",
        faq: [
            { question: "Is Conductor free, and what does Pro cost?", answer: "The local desktop tier is free. Pro costs $50/month and adds cloud workspaces, phone access and collaboration. Teams is $60/user/month, currently invite-only. Agent subscriptions or API usage are separate. intentic's self-hosted software is free; optional hosting is not always free." },
            { question: "Does Conductor work on Windows or Linux?", answer: "Not yet, according to its installation docs. For a browser-based alternative, use intentic from either operating system with a supported sandbox host. T3 Code and Synara are also worth comparing if you specifically want a cross-platform desktop app." },
            { question: "Is Conductor open source?", answer: "No. Its client uses a proprietary licence. intentic is MIT-licensed, so you can inspect, modify and self-host it. Free desktop access and an open-source licence are different things." },
            { question: "Conductor vs Superset: what is the main difference?", answer: "Both organise parallel coding agents. Conductor focuses on its Mac app and managed cloud. Superset offers a desktop/CLI workspace, experimental Linux support and paid remote features. Superset is source-available under Elastic License 2.0, not MIT-licensed like intentic." },
            { question: "Conductor vs T3 Code: which should I choose?", answer: "Choose Conductor for its Mac experience and managed cloud. T3 Code is a free MIT-licensed option with Windows and Linux desktop apps and remote clients. intentic is a third choice when the priority is a shared browser workspace around machines you control." },
            { question: "Can Conductor run remotely, and is cloud compute extra?", answer: "Yes. Paid plans include Conductor Cloud and phone access. Its pricing page currently says cloud compute has no extra charge, with usage-based pricing planned. Self-hosting Conductor Cloud on your own machines is not currently supported. Check the latest pricing before budgeting." },
        ],
        sources: [
            { label: "Pricing", url: "https://www.conductor.build/pricing" },
            { label: "Installation", url: "https://www.conductor.build/docs/installation" },
            { label: "API and routines", url: "https://www.conductor.build/docs/api" },
            { label: "Worktrees", url: "https://www.conductor.build/docs/guides/git-worktrees/run-claude-code-with-git-worktrees" },
            { label: "Terms", url: "https://www.conductor.build/terms" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Conductor Alternative: Free & Open Source | intentic", description: "Compare Conductor vs intentic: pricing, Windows and Linux support, open-source licensing, remote access and cloud workspaces. See which fits your workflow.", datePublished: PUBLISHED },
    },
    {
        slug: "superset",
        name: "Superset",
        url: "https://superset.sh/",
        navLabel: "intentic vs Superset",
        menuBlurb: "Compare Superset pricing, licensing and remote access with an MIT-licensed browser workspace.",
        family: "orchestrators",
        heading: "Superset vs intentic: compare coding workspaces",
        sub: "Looking for a Superset alternative? Compare free plans, open-source licensing, Windows and Linux support, and mobile access. This is superset.sh, not Apache Superset.",
        theirPitch: "Superset brings coding agents, terminals and diffs into a desktop and CLI workspace, with optional remote, mobile and cloud features.",
        verdict: [
            "Superset is a close alternative for managing several coding agents. Choose it for its desktop/CLI workflow and iPhone companion. Choose intentic for an MIT-licensed workspace with browser access and self-hosted sharing.",
            "Superset's local tier is free. Remote access and automations are paid features, and its source-available licence is not the same as an open-source MIT licence.",
        ],
        overlap: { title: "Similar day-to-day work", body: "Both support parallel agent tasks, terminals and reviewing code changes. Superset's Git workspaces use ordinary worktrees; isolation does not remove the need to review and merge changes carefully." },
        differences: [
            { title: "Superset pricing and licensing", body: "Free covers one member's local work. Pro is $20/active seat/month, or $15/month billed annually. Remote access and automations are paid. intentic has no software feature or seat charge when self-hosted; AI and optional hosting costs remain." },
            { title: "Windows, Linux and browser access", body: "Superset supports macOS. Its Linux desktop AppImage is experimental and untested; Windows is planned. There is no supported web dashboard. intentic uses a browser interface and a sandbox on a supported Docker host." },
            { title: "Mobile work and connected machines", body: "Superset has an iPhone app and a relay for remote work. intentic offers browser access to its shared workspace. Superset schedules need an online, connected target; intentic jobs likewise need a running host. Remote access is not a privacy guarantee." },
        ],
        table: [
            { label: "Licence", intentic: "MIT open source", them: "Source-available Elastic License 2.0; not OSI open source" },
            { label: "Free plan", intentic: "Self-hosted features and sharing included", them: "One-member local desktop and CLI use" },
            { label: "Desktop workflow", intentic: "Shared browser interface around sandboxed work", them: "Agent terminals, diffs, CLI, SDK and MCP integration", theirs: true },
            { label: "Linux and Windows", intentic: "Browser access from either; supported Docker host needed", them: "Experimental Linux desktop; Linux CLI; Windows planned" },
            { label: "Mobile access", intentic: "Browser access", them: "Native iPhone app; Android not yet", theirs: true },
            { label: "Automation", intentic: "Scheduled and event-driven turns on a running host", them: "Paid automations; target must be online and relay-connected" },
        ],
        pickThem: "Pick Superset if you prefer agent terminals in a desktop app, want its CLI/SDK integrations, or value a native iPhone companion. Its free local tier makes it easy to try. Check the paid remote features and Linux limitations before moving a team onto it.",
        faq: [
            { question: "Is superset.sh free, and what does Pro cost?", answer: "Superset's local single-member tier is $0. Pro is $20 per active seat per month, or $180 per seat per year. Model subscriptions and API costs are separate. intentic is free to self-host, with model usage and optional hosted machines paid separately." },
            { question: "Is Superset an open-source coding workspace?", answer: "Superset uses Elastic License 2.0. Its source is available, but its homepage FAQ explicitly says it is not OSI open source. intentic uses MIT. This comparison is about superset.sh; Apache Superset is a different, unrelated analytics project." },
            { question: "Does Superset support Windows or Linux?", answer: "Windows support is planned, with no date stated. The Linux x64 desktop AppImage is experimental and untested; the CLI supports Linux x64 and arm64. For browser access from Windows or Linux, compare intentic. For a native desktop app, also examine T3 Code or Synara." },
            { question: "Does Superset have remote access or a mobile app?", answer: "Yes. Superset offers paid relay-based remote access and an iPhone app. Android is not yet available, and there is no supported web dashboard. The target machine must be online for remote jobs and schedules to run." },
            { question: "Superset vs Conductor: which is better?", answer: "Conductor is a Mac-focused app with managed cloud workspaces. Superset provides a desktop/CLI workflow, experimental Linux support and paid remote tools. intentic is worth considering if you want an MIT-licensed browser workspace rather than either desktop app." },
            { question: "Superset vs T3 Code: what should I compare?", answer: "Compare the licence, supported operating systems and remote workflow. T3 Code is MIT-licensed and has cross-platform desktop and mobile clients. Superset is source-available and gates remote features behind paid plans. Both need separate agent accounts or model access." },
        ],
        sources: [
            { label: "Pricing", url: "https://superset.sh/pricing" },
            { label: "Homepage FAQ and licence", url: "https://superset.sh/" },
            { label: "FAQ and platform support", url: "https://docs.superset.sh/faq" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Superset Alternative: Pricing & Open Source | intentic", description: "Compare superset.sh vs intentic for parallel coding agents. Check free plans, MIT vs Elastic licensing, Windows and Linux support, remote access and mobile apps.", datePublished: PUBLISHED },
    },
    {
        slug: "t3-code",
        name: "T3 Code",
        url: "https://t3.codes/",
        navLabel: "intentic vs T3 Code",
        menuBlurb: "Two free, MIT-licensed tools: compare desktop/mobile agent sessions with a shared browser workspace.",
        family: "orchestrators",
        heading: "T3 Code vs intentic: free coding workspaces compared",
        sub: "Compare T3 Code pricing, open-source licensing, Windows and Linux support, remote hosts and mobile apps. Both products are free to self-host.",
        theirPitch: "T3 Code is an open-source interface for multiple coding agents, with desktop, browser and mobile clients and connections to remote machines.",
        verdict: [
            "Choose T3 Code for a focused agent interface across desktop and mobile. Choose intentic when you want one browser workspace for agent tasks, sandbox setup, shared reviews and recurring work.",
            "T3 Code already supports multiple agents and remote hosts. Free software, browser access and self-hosting are shared benefits—not reasons to claim it is behind.",
        ],
        overlap: { title: "Free software around existing agents", body: "Both use your agent credentials and can work on your own machines. Both support parallel tasks and Git review. Hosted model usage remains subject to your provider's pricing and limits." },
        differences: [
            { title: "Desktop and mobile, or a shared browser", body: "T3 Code has macOS, Windows and Linux desktop apps, plus iOS and Android clients. intentic centres the workflow on a browser workspace, including machine setup, agent permissions and accepting changes." },
            { title: "Remote hosts are supported by both", body: "T3 Code supports pairing, private networks and desktop-managed SSH. Its hosted web client connects to your own server; it is not managed agent compute. intentic also needs a running host, whether it is your desktop, server or optional hosted sandbox." },
            { title: "What happens around the coding session", body: "T3 Code offers integrated diffs, commits and pull requests, and can balance new threads across connected machines. intentic also manages sandbox environments, scheduled/event-driven work and the step that lands reviewed changes in the owner's checkout." },
        ],
        table: [
            { label: "Software price", intentic: "Free to self-host; model and optional hosting costs separate", them: "Free software; model costs separate" },
            { label: "Licence", intentic: "MIT", them: "MIT" },
            { label: "Clients", intentic: "Shared browser workspace", them: "Desktop, browser, iOS and Android", theirs: true },
            { label: "Remote machines", intentic: "Connect to your chosen sandbox hosts", them: "Pairing, Tailscale/private networks and SSH" },
            { label: "Multiple machines", intentic: "Choose the machine for agent work", them: "Load-balancing preferences for new threads", theirs: true },
            { label: "Code review", intentic: "Inspect changes and land them in the owner's checkout", them: "Diffs, worktrees, commits, push and PR creation" },
        ],
        pickThem: "Pick T3 Code if you want a free cross-platform agent app with native mobile clients and straightforward Git actions. Its remote pairing and multi-machine workflow may cover everything you need without adopting a broader sandbox-management workspace.",
        faq: [
            { question: "Is T3 Code free and open source?", answer: "Yes. T3 Code is MIT-licensed and free software. Agent subscriptions and API usage can still cost money. intentic has the same free MIT software model, with optional paid hosted machines. Free software is not unlimited free inference." },
            { question: "Does T3 Code work on Windows and Linux?", answer: "Yes. Desktop builds support macOS, Windows and Linux. SSH-managed remote hosts have narrower documented requirements: Linux or Apple Silicon Macs. Do not assume Windows desktop support also means Windows SSH-host parity." },
            { question: "Can I access T3 Code remotely or from my phone?", answer: "Yes. T3 Code provides iOS and Android clients, a browser client and connections to your running server. Pairing, T3 Connect, private networks and SSH are supported paths. The machine doing the agent work must remain running and reachable." },
            { question: "T3 Code vs Codex or OpenCode: are they alternatives?", answer: "They are different parts of the workflow. Codex and OpenCode are coding agents; T3 Code is an interface that can run them alongside other supported agents. intentic can run Codex directly and OpenCode through ACP, with its own workspace and review workflow." },
            { question: "T3 Code vs Conductor: what is the main difference?", answer: "T3 Code is free MIT software with Windows and Linux desktop support and mobile clients. Conductor focuses on macOS and offers managed cloud workspaces on paid plans. Choose based on client experience and who should operate the compute, not just the number of agents." },
            { question: "T3 Code vs Superset: which is open source?", answer: "T3 Code uses MIT. Superset uses the source-available Elastic License 2.0, not an OSI open-source licence. Both offer local agent workflows and remote options. intentic also uses MIT and adds a shared browser workspace around sandboxed work." },
        ],
        sources: [
            { label: "Source and licence", url: "https://github.com/pingdotgg/t3code" },
            { label: "Remote access", url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md" },
            { label: "Threads and worktrees", url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "T3 Code vs intentic: Free Coding Workspaces Compared", description: "Looking for a T3 Code alternative? Compare pricing, MIT licensing, Windows and Linux apps, remote access, mobile clients and shared agent workflows.", datePublished: PUBLISHED },
    },
    {
        slug: "synara",
        name: "Synara",
        url: "https://www.trysynara.com/",
        navLabel: "intentic vs Synara",
        menuBlurb: "Compare two free MIT workspaces, including agent handoffs, scheduled tasks and self-hosted remote access.",
        family: "orchestrators",
        heading: "Synara vs intentic: open-source agent workspaces",
        sub: "Compare Synara pricing, Windows and Linux apps, headless remote access and automations. This guide covers the coding workspace at trysynara.com.",
        theirPitch: "Synara is a free, open-source coding workspace with multiple agent providers, task handoffs, review tools and recurring automations.",
        verdict: [
            "Synara is a genuine free, self-hosted alternative—not just a Mac chat app. Choose it for its task-focused desktop interface, broad agent support and handoffs. Choose intentic for a shared browser workspace that also manages sandbox environments and connections.",
            "Both are MIT-licensed and support automations. Compare how each handles your actual tasks and review process; do not choose on an outdated claim that one lacks remote access or scheduling.",
        ],
        overlap: { title: "Multiple agents, local work and automations", body: "Both can run coding tasks on your hardware and keep work on separate branches. Synara offers optional worktrees; intentic uses per-conversation worktrees. Hosted providers can still receive prompts and code." },
        differences: [
            { title: "Task handoffs and workspace management", body: "Synara lets supported agents hand off tasks while retaining the task environment. intentic combines agent work with machine setup, connected services, permissions and owner-reviewed landing. Agent choice matters, but so does what the workspace manages around it." },
            { title: "Desktop or self-hosted browser access", body: "Synara ships macOS, Windows and Linux apps plus a headless server. Remote access uses your own network and authentication token. intentic is browser-first. Neither self-hosted option makes an offline host reachable by itself." },
            { title: "Scheduled work is not unique to intentic", body: "Synara has recurring and heartbeat automations, with pause/resume and failure policies. intentic also starts turns from schedules and events. Test trigger behavior, review settings and recovery on the machine you intend to leave running." },
        ],
        table: [
            { label: "Price and licence", intentic: "Free MIT software; AI/optional hosting separate", them: "Free MIT software; no paid feature tier; AI separate" },
            { label: "Desktop platforms", intentic: "Browser workspace on a supported sandbox host", them: "macOS, Windows and Linux desktop apps", theirs: true },
            { label: "Agent portability", intentic: "Supported native runtimes plus ACP agents", them: "Broad provider support and task handoffs", theirs: true },
            { label: "Remote access", intentic: "Browser access to your shared workspace", them: "Headless server; self-managed LAN or Tailscale access" },
            { label: "Automation", intentic: "Scheduled and event-driven agent turns", them: "Recurring and heartbeat work with lifecycle controls" },
            { label: "Review boundary", intentic: "Review before landing in the owner's checkout", them: "Task diffs, terminal/browser context and PR workflow" },
        ],
        pickThem: "Pick Synara if you want a no-paywall desktop workspace, switch between several coding agents and value handoffs within a task. Its headless server and recurring automations are substantial features. Try the browser and review flow on a real project before assuming you need another workspace.",
        faq: [
            { question: "Is Synara free and open source?", answer: "Yes. Synara uses MIT and has no paid feature tier. Sponsorships fund the project rather than unlock features. You still authenticate with your agent providers and pay any subscription or API charges. intentic is also free MIT software to self-host." },
            { question: "Does Synara run on Windows and Linux?", answer: "Yes. Synara provides Windows x64 and Linux x86_64 desktop builds, as well as Apple Silicon and Intel Mac builds. It also ships a headless server package with Node and dependency requirements. Check the installation page for your architecture." },
            { question: "Can Synara be used remotely?", answer: "Yes. Its headless server can be reached through your own LAN or private network such as Tailscale, using your authentication token. That is self-hosted access, not a Synara-managed cloud service. A native mobile app was not established by the sources checked here." },
            { question: "Does Synara support scheduled automations?", answer: "Yes. Current releases include recurring and heartbeat automations, pause/resume controls and failure policies. They are shipped features, not merely a roadmap item. Running work still requires a usable host and provider access." },
            { question: "Synara vs T3 Code: what should I compare?", answer: "Synara emphasises task handoffs and recurring automations. T3 Code offers desktop, browser and native mobile clients with remote-machine workflows. Both are free MIT software. Compare their review experience and the agents you actually use." },
            { question: "Synara vs Superset: which has a free open-source licence?", answer: "Synara is MIT-licensed with no paid feature tier. Superset has a free local tier but uses Elastic License 2.0, and remote features are paid. intentic is another MIT option if you prefer a browser workspace with self-hosted sharing." },
        ],
        sources: [
            { label: "Installation", url: "https://www.trysynara.com/docs/getting-started/installation" },
            { label: "Changelog and automations", url: "https://www.trysynara.com/changelog" },
            { label: "Privacy and remote access", url: "https://www.trysynara.com/privacy" },
            { label: "Sponsorships", url: "https://www.trysynara.com/donors" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Synara vs intentic: Free Open-Source Agent Workspaces", description: "Compare Synara and intentic: free MIT licensing, Windows and Linux support, agent handoffs, remote access and scheduled automations. Find the right workspace.", datePublished: PUBLISHED },
    },
    {
        slug: "nimbalyst",
        name: "Nimbalyst",
        url: "https://nimbalyst.com/",
        navLabel: "intentic vs Nimbalyst",
        menuBlurb: "Compare visual document editing and mobile review with browser-based sandbox and agent management.",
        family: "orchestrators",
        heading: "Nimbalyst vs intentic: compare open-source workspaces",
        sub: "Compare Nimbalyst pricing, open-source licensing, Windows and Linux support, iOS review and automations. Choose a workflow, not a feature checklist.",
        theirPitch: "Nimbalyst combines coding agents with visual editing for Markdown, diagrams, data and mockups, plus task boards and an iOS companion.",
        verdict: [
            "Choose Nimbalyst when the work includes documents, diagrams or visual mockups alongside code. Choose intentic when you mainly need a shared browser workspace for coding agents, sandbox environments and reviewed changes.",
            "Both have free self-hosted software. Nimbalyst already supports Windows, Linux, mobile review and scheduled tasks; those are not missing features that intentic alone supplies.",
        ],
        overlap: { title: "Agent work with visible review", body: "Both organise tasks and let you inspect edits. Nimbalyst can create a worktree for a session; intentic separates conversations into worktrees and lands accepted work into the owner's checkout." },
        differences: [
            { title: "Visual editing or sandbox management", body: "Nimbalyst has editors for Markdown, CSV, Mermaid, Excalidraw and mockups. intentic centres code changes, machine environments and connected tools. If visual documents are the main output, Nimbalyst may be the closer fit." },
            { title: "Nimbalyst pricing and collaboration", body: "Individuals are free. Teams lists $20/seat/month or $200/seat/year, but is currently free during beta. Its collaboration service is separate from the MIT desktop/iOS code. intentic includes shared-workspace features in its free self-hosted software." },
            { title: "Mobile review and scheduled tasks", body: "Nimbalyst's iOS app can monitor sessions, send replies and approve changes. Its automations run while Nimbalyst is open. intentic uses browser access and runs schedules on a chosen host, which can be an always-on server." },
        ],
        table: [
            { label: "Software licence", intentic: "MIT", them: "MIT desktop and iOS; collaboration service is separate" },
            { label: "Personal price", intentic: "Free to self-host; model/hosting costs separate", them: "Free personal workspace; model costs separate" },
            { label: "Visual documents", intentic: "Files and viewers within the coding workspace", them: "Rich document, diagram, data and mockup editing", theirs: true },
            { label: "Operating systems", intentic: "Browser interface; supported sandbox host needed", them: "macOS, Windows and Linux desktop apps" },
            { label: "Mobile workflow", intentic: "Browser access", them: "iOS companion with replies and change approval", theirs: true },
            { label: "Scheduled work", intentic: "Schedules/events on a running sandbox", them: "Automations while the app is open" },
        ],
        pickThem: "Pick Nimbalyst if you want one place for agent-edited documents, diagrams, mockups and code. Its visual editors, task boards and iOS review are useful advantages. An always-on coding server is a different need, not proof that a document-oriented workspace is inferior.",
        faq: [
            { question: "Is Nimbalyst free, and what does Teams cost?", answer: "The individual workspace is free. Teams lists $20 per seat per month or $200 per seat per year, but is currently free during beta. No beta end date was stated in the checked pricing page. AI provider costs remain separate." },
            { question: "Is Nimbalyst open source?", answer: "Its desktop and iOS code is MIT-licensed. Do not assume that licence also covers the separately maintained collaboration service. intentic's self-hosted workspace uses MIT and includes sharing without a software seat fee." },
            { question: "Does Nimbalyst support Windows, Linux and mobile?", answer: "Yes: macOS, Windows and Linux desktop builds and an iOS companion are documented. The iOS app supports session monitoring, replies and change review. Android availability was not verified in the official sources checked here." },
            { question: "Nimbalyst vs Cursor or VS Code: is it a full IDE replacement?", answer: "Nimbalyst is an agent workspace with visual document editors, not simply another VS Code distribution. Cursor and VS Code suit editor-first coding. Nimbalyst is attractive when code, notes, diagrams and mockups belong in the same agent workflow." },
            { question: "Nimbalyst vs Conductor or Superset: what is different?", answer: "All organise agent sessions. Nimbalyst puts more emphasis on visual files and task boards. Conductor focuses on Mac parallel coding and managed cloud; Superset centres agent terminals and desktop/CLI work. intentic focuses on shared browser access and sandbox management." },
            { question: "Can Nimbalyst schedule agent tasks?", answer: "Yes. It supports daily, weekly and interval automations, with a disabled draft for review before enabling. The app must be open for scheduled work. If you need an always-on server workflow, compare that operational requirement with intentic's host-based schedules." },
        ],
        sources: [
            { label: "Pricing", url: "https://www.nimbalyst.com/pricing/" },
            { label: "Source and platforms", url: "https://github.com/nimbalyst/nimbalyst" },
            { label: "Automations", url: "https://nimbalyst.com/docs/session-management/automations/" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Nimbalyst Alternative: Pricing & Workflows | intentic", description: "Compare Nimbalyst vs intentic for coding agents. Check free and team pricing, open-source licences, Windows and Linux support, visual editing and mobile review.", datePublished: PUBLISHED },
    },
    {
        slug: "cursor",
        name: "Cursor",
        url: "https://cursor.com/",
        navLabel: "intentic vs Cursor",
        menuBlurb: "Keep Cursor for editing, or run its agent in a free, self-hosted browser workspace.",
        family: "editors",
        heading: "Cursor alternatives: where intentic fits",
        sub: "Compare Cursor pricing, free and open-source alternatives, local models and cloud agents. intentic is an agent workspace—not a drop-in code editor.",
        theirPitch: "Cursor combines an AI code editor, a terminal agent and cloud agents that can work in parallel and open pull requests.",
        verdict: [
            "Keep Cursor if you want AI help while editing code. Choose intentic when you want to assign tasks to agents, run them on chosen machines and review their work in a shared browser workspace.",
            "You can also run Cursor's agent inside intentic. That keeps Cursor's account requirements; free workspace software does not turn a paid Cursor plan into free model usage.",
        ],
        overlap: { title: "Both support agent-led coding", body: "Both can run parallel work and provide code review. Cursor already has cloud execution, scheduling and customer-hosted workers. The useful distinction is editor-first work versus broader workspace and machine management." },
        differences: [
            { title: "Editor replacement or agent workspace?", body: "Cursor provides inline suggestions, chat and agent tools in an IDE. intentic does not replace those typing-time features. It manages supported agents, task environments, permissions and reviewed changes. Keep an editor alongside it when that suits your workflow." },
            { title: "Free software and Cursor pricing", body: "Cursor has a limited free Hobby plan; Pro is $20/month and Teams is $40/user/month. AI allowances and overages depend on the plan and model. intentic is MIT-licensed and free to self-host; provider accounts and optional hosted machines are separate." },
            { title: "Self-hosting and local models", body: "Cursor's self-hosted workers run tools on your hardware, but Cursor still runs the agent loop and inference. intentic lets you choose supported runtimes and their model backends. For local inference, use an agent that supports local models; it is not automatic for every agent." },
        ],
        table: [
            { label: "Main workflow", intentic: "Assign tasks and review results in a browser", them: "Edit code with inline AI and IDE tools", theirs: true },
            { label: "Licence", intentic: "MIT open-source workspace", them: "Proprietary editor and service" },
            { label: "Starting price", intentic: "Free to self-host; AI/hosting separate", them: "Limited free Hobby; Pro $20/month" },
            { label: "Cloud work", intentic: "Your always-on host or optional hosted machine", them: "Managed asynchronous cloud agents", theirs: true },
            { label: "Customer-hosted execution", intentic: "Workspace and agent tools on your sandbox host", them: "Self-hosted workers; agent loop and inference stay hosted" },
            { label: "Automation", intentic: "Schedules and connected-service events", them: "Cursor Automate schedules and events" },
        ],
        together: { title: "Run Cursor's agent in intentic", body: "Use your eligible Cursor account for agent turns in intentic, while keeping Cursor's editor for hands-on work. intentic adds its workspace, machine and review controls; it does not replace Cursor's licence or billing. Other supported agents can work alongside it." },
        pickThem: "Pick Cursor if most of your day happens inside a code editor and inline suggestions matter. Its integrated IDE and managed cloud agents are real advantages. Adopting intentic makes more sense when coordinating tasks, providers and machines is the problem you need to solve.",
        faq: [
            { question: "Is intentic a free, open-source Cursor alternative?", answer: "It is free MIT-licensed workspace software, but not a like-for-like editor replacement. Use it for agent-led coding and shared review. Running Cursor inside it still requires appropriate Cursor access; models and optional hosted compute can cost money." },
            { question: "What does Cursor cost?", answer: "Cursor offers a limited free Hobby tier, Pro at $20/month and Teams at $40/user/month. Other plans and metered usage are listed on its pricing page. Compare the included allowance, overages and cloud usage, not just the subscription price." },
            { question: "Can I use local models instead of Cursor's hosted models?", answer: "For a local-model agent workflow, compare OpenCode or Codex CLI configured with a supported local backend. intentic can manage supported agents around that workflow. Cursor's self-hosted worker feature is about tool execution, not running Cursor's inference locally." },
            { question: "Is Cursor fully self-hosted or offline?", answer: "No. Its customer-hosted workers send task data back to Cursor, which handles planning and inference. Privacy Mode is not an offline mode. With intentic, locally running tools can also send code to hosted providers; check the selected agent and model configuration." },
            { question: "Cursor vs Claude Code or Codex: what is different?", answer: "Cursor includes a full editor. Claude Code and Codex are coding agents with terminal and other interfaces. All have overlapping agent features, so compare the editing experience, account costs and workflow. intentic can run these supported agents rather than forcing you to pick one for every task." },
            { question: "Does Cursor already offer cloud agents and scheduling?", answer: "Yes. Cursor offers managed cloud agents, scheduled/event-driven automation and self-hosted workers. intentic is an alternative way to operate a workspace, not the only way to run agents remotely or in parallel. Managed cloud may be preferable if you want less infrastructure work." },
        ],
        sources: [
            { label: "Pricing", url: "https://cursor.com/pricing" },
            { label: "Cloud agents", url: "https://cursor.com/docs/cloud-agent" },
            { label: "Self-hosted machines", url: "https://cursor.com/docs/cloud-agent/self-hosted" },
            { label: "Automate", url: "https://cursor.com/automate" },
            { label: "Data use", url: "https://cursor.com/en-US/data-use" },
            { label: "Terms", url: "https://cursor.com/en-US/terms-of-service" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Cursor Alternative: Free, Open-Source Workspace | intentic", description: "Looking for a Cursor alternative? Compare free and open-source options, pricing, local models and cloud agents. Learn when to use intentic alongside Cursor.", datePublished: PUBLISHED },
    },
    {
        slug: "claude-code",
        name: "Claude Code",
        url: "https://code.claude.com/docs/en/overview",
        navLabel: "intentic vs Claude Code",
        menuBlurb: "Run Claude Code in intentic—or compare free agents, local models and other coding workflows.",
        family: "harnesses",
        heading: "Claude Code alternatives—and when to keep Claude Code",
        sub: "Compare free and open-source alternatives, Claude Code pricing, local models and self-hosting. intentic can run Claude Code; it is not a replacement model.",
        theirPitch: "Claude Code is Anthropic's coding agent, available through terminal, IDE, desktop and hosted workflows, with tools for editing and testing repositories.",
        verdict: [
            "Keep Claude Code if you like how it handles coding tasks. intentic runs it inside a shared browser workspace and adds machine management, other agent runtimes and owner-reviewed landing.",
            "If you want to replace Claude Code itself, compare agents such as OpenCode or Codex. Installing intentic does not remove Claude Code's account costs or automatically move Claude inference onto your machine.",
        ],
        overlap: { title: "Claude Code already has more than a CLI", body: "It supports parallel sessions, subagents, remote control and scheduled workflows. intentic builds a workspace around supported agents; it does not claim those capabilities are exclusive." },
        differences: [
            { title: "Agent behavior or workspace controls", body: "Claude Code supplies the coding agent and tools. intentic supplies the workspace around the run: sandbox setup, connected services, sharing and the step that lands accepted work. The two solve related but different problems." },
            { title: "Claude Code pricing and free alternatives", body: "Claude Pro is $20/month; Max starts at $100/month. API access is metered separately, and subscription usage has limits. intentic is free software, not free Claude access. OpenCode and Codex CLI offer open-source agent code, with their own model costs." },
            { title: "Local execution is not local Claude inference", body: "Claude Code normally calls networked model services. Anthropic also offers customer-hosted runner options that retain hosted control services. Ollama documents an alternative-model integration; that does not mean Claude's model weights run locally or every feature works offline." },
        ],
        table: [
            { label: "What it provides", intentic: "Shared workspace, environments and review around agents", them: "The coding agent, tools and Claude-specific workflows" },
            { label: "Licence", intentic: "MIT workspace software", them: "Commercial/consumer terms, not an MIT runtime" },
            { label: "AI cost", intentic: "Your selected provider's account or usage charges", them: "Eligible subscription or separately metered API/provider access" },
            { label: "Terminal and IDE use", intentic: "Browser-centred agent management", them: "Direct coding workflow in terminal and IDE", theirs: true },
            { label: "Cloud and remote", intentic: "Workspace on your chosen running host", them: "Hosted routines, web sessions and Remote Control", theirs: true },
            { label: "Other agent runtimes", intentic: "Run supported agents alongside Claude Code", them: "Claude Code's own agent runtime" },
        ],
        together: { title: "Use Claude Code inside intentic", body: "Bring your eligible Claude account or configured provider access and keep the native agent. Review its changes in intentic, or delegate other tasks to another supported runtime. Your provider terms and limits still apply; intentic does not resell or bypass Claude access." },
        pickThem: "Use Claude Code directly if its terminal, IDE or hosted workflows already cover your needs. It is a good choice when you want Claude's agent behavior without adopting another workspace. Add intentic when shared environments, cross-runtime tasks or a separate acceptance step would help.",
        faq: [
            { question: "What are free, open-source alternatives to Claude Code?", answer: "OpenCode is MIT-licensed and Codex CLI is Apache 2.0. Their software is free, but hosted models can cost money. intentic is also MIT-licensed, but is a workspace around agents rather than a substitute agent or a way to get free Claude usage." },
            { question: "How much does Claude Code cost?", answer: "Claude Code is included in eligible paid Claude plans; Pro is $20/month and Max starts at $100/month. API/provider access can be billed separately. The free Claude plan does not include Claude Code. Check current usage limits and extra-credit rules before choosing." },
            { question: "Can Claude Code use local models?", answer: "Ollama documents connecting Claude Code to alternative local models through an Anthropic-compatible API. This is an Ollama integration, not local Claude weights or a promise of full feature parity. OpenCode and Codex CLI also document local model backends." },
            { question: "Can Claude Code be self-hosted?", answer: "You can run its tools locally. Anthropic also offers self-hosted cloud runners on eligible plans, but hosted control and model services remain involved. intentic can host Claude Code's workspace on your hardware; it does not make the agent or inference automatically offline." },
            { question: "Claude Code vs Cursor or Codex: which should I choose?", answer: "Cursor adds an editor-first experience; Claude Code and Codex offer agent-led coding across several interfaces. Test the agents on your own code and compare costs and review flows. intentic can run supported runtimes side by side, including Claude Code, Cursor and Codex." },
            { question: "Claude Code vs OpenCode: what is the main difference?", answer: "Claude Code is governed by Anthropic's service and software terms. OpenCode is an MIT-licensed agent with documented cloud and local model choices. Both can work on repositories. intentic adds workspace management to either supported workflow rather than replacing their agent behavior." },
            { question: "Can I use a Claude Code alternative in VS Code?", answer: "OpenCode and Codex offer editor workflows as well as terminal interfaces. Compare their model costs and integration with your editor. intentic is a separate browser workspace for supported agents, not a drop-in VS Code extension or inline completion replacement." },
        ],
        sources: [
            { label: "Overview and workflows", url: "https://code.claude.com/docs/en/overview" },
            { label: "Pricing", url: "https://claude.com/pricing" },
            { label: "Legal and compliance", url: "https://code.claude.com/docs/en/legal-and-compliance" },
            { label: "Self-hosted environments", url: "https://code.claude.com/docs/en/self-hosted-environments" },
            { label: "Ollama integration", url: "https://github.com/ollama/ollama/blob/main/docs/integrations/claude-code.mdx" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Claude Code Alternatives: Free & Open Source | intentic", description: "Compare Claude Code alternatives, pricing, local models and self-hosting. Learn when to use OpenCode or Codex, and how intentic can run Claude Code itself.", datePublished: PUBLISHED },
    },
    {
        slug: "opencode",
        name: "OpenCode",
        url: "https://opencode.ai/",
        navLabel: "intentic vs OpenCode",
        menuBlurb: "OpenCode is already free and local-model capable. Add intentic when you need a broader agent workspace.",
        family: "harnesses",
        heading: "OpenCode vs intentic: agent or shared workspace?",
        sub: "Compare OpenCode pricing, local models, self-hosting and alternatives. Both are open source, and intentic can run OpenCode through ACP.",
        theirPitch: "OpenCode is an MIT-licensed coding agent with terminal, desktop, editor and browser workflows and a choice of cloud or local model backends.",
        verdict: [
            "Use OpenCode directly if you want a free, configurable coding agent. Add intentic if you need to manage that agent alongside other runtimes, sandbox environments and shared review.",
            "OpenCode already supports local models and multiple sessions. intentic is not a cheaper replacement for an agent that is already free; it is an optional workspace around it.",
        ],
        overlap: { title: "Both are open-source and self-hostable", body: "Both can work with your own machines and model access. OpenCode supplies the agent; intentic manages supported agents and their workspace. The selected model and service still determine inference costs and data handling." },
        differences: [
            { title: "OpenCode pricing: agent vs model service", body: "The agent code is free under MIT. Optional Go plans start at $10/month; Zen offers metered model access and some free offers. Your own providers have their own charges. intentic's self-hosted software is free too, with optional hosting and provider costs separate." },
            { title: "Local models and provider choice", body: "OpenCode documents Ollama, LM Studio, vLLM and compatible endpoints. Model capability and hardware affect results. intentic does not turn every agent into OpenCode or make all providers interchangeable; it manages supported runtimes and their configurations." },
            { title: "Permissions are not a merge review", body: "OpenCode can allow, ask about or deny tools. intentic also controls agent access and keeps review before landing changes into the owner's checkout. Approving a command and approving the resulting code are different decisions." },
        ],
        table: [
            { label: "Main role", intentic: "Workspace and operations around agents", them: "Configurable coding agent" },
            { label: "Software licence", intentic: "MIT", them: "MIT agent code; model/service terms separate" },
            { label: "Local models", intentic: "Use a supported agent with a local-model backend", them: "Documented Ollama, LM Studio and vLLM support", theirs: true },
            { label: "Direct interfaces", intentic: "Shared browser workspace", them: "Terminal, desktop, editor and browser workflows", theirs: true },
            { label: "Tool permissions", intentic: "Workspace permissions plus each runtime's controls", them: "Configurable allow/ask/deny rules" },
            { label: "Code acceptance", intentic: "Review and land work in the owner's checkout", them: "Review and merge through your chosen Git workflow" },
        ],
        together: { title: "Run OpenCode in intentic through ACP", body: "Connect a supported OpenCode ACP setup to intentic and keep OpenCode's model configuration. intentic supplies the workspace and review flow. This does not guarantee every OpenCode interface or version-specific feature appears identically in the browser." },
        pickThem: "Use OpenCode directly when provider flexibility, local inference or terminal-driven coding is your main goal. Its open-source agent and model configuration may be all you need. Add a workspace only when coordinating tasks, machines and reviews becomes a separate problem.",
        faq: [
            { question: "Is OpenCode free and open source?", answer: "Yes. The agent code is MIT-licensed and free to run. That licence does not make every model or hosted service free. Cloud model usage, optional Go/Zen services and infrastructure can cost money. intentic is also MIT-licensed workspace software." },
            { question: "What does OpenCode cost?", answer: "The agent itself is free. Optional Go starts at $10/month and Go Plus is $40/month, with usage limits. Zen is an optional metered model service. You can also use your own provider or supported local model, with its separate costs and terms." },
            { question: "Can OpenCode run local models or be self-hosted?", answer: "Yes. OpenCode documents local backends including Ollama, LM Studio and vLLM. Running an agent locally does not make cloud providers or external tools offline. Configure the actual model endpoint and tool access for your intended privacy boundary." },
            { question: "OpenCode vs Claude Code: which is better?", answer: "OpenCode offers MIT agent code and flexible model backends. Claude Code has Anthropic's agent workflow and commercial terms. Test the agent and model combination on your repository rather than assuming the licence predicts coding quality. intentic can manage either supported setup." },
            { question: "OpenCode vs Cursor or Codex: what changes?", answer: "Cursor includes an editor; OpenCode is a configurable agent. Codex CLI is also open source and supports local backends. Their models, tools and interfaces differ. intentic lets supported agents work in one workspace, but does not replace their individual behavior." },
            { question: "Is intentic an OpenCode alternative or an integration?", answer: "Primarily an optional workspace integration. You can run OpenCode through ACP and add shared task, environment and review management. If OpenCode alone covers your needs, there is no requirement to add intentic. If you want a different agent, compare other runtimes directly." },
        ],
        sources: [
            { label: "Current v2 documentation", url: "https://opencode.ai/v2/docs" },
            { label: "Models", url: "https://opencode.ai/v2/docs/models" },
            { label: "Permissions", url: "https://opencode.ai/v2/docs/permissions" },
            { label: "MIT licence", url: "https://github.com/anomalyco/opencode/blob/v2/LICENSE" },
            { label: "Go pricing", url: "https://opencode.ai/docs/go/" },
            { label: "Zen", url: "https://opencode.ai/docs/zen/" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "OpenCode vs intentic: Pricing, Local Models & Alternatives", description: "Is OpenCode free? Compare pricing, MIT licensing, local models and self-hosting. See OpenCode vs Claude Code, Cursor and Codex, and how intentic runs OpenCode.", datePublished: PUBLISHED },
    },
    {
        slug: "openclaw",
        name: "OpenClaw",
        url: "https://openclaw.ai/",
        navLabel: "intentic vs OpenClaw",
        menuBlurb: "Compare a self-hosted personal assistant with a workspace built around repository tasks and code review.",
        family: "assistants",
        heading: "OpenClaw alternatives for coding: compare intentic",
        sub: "Compare OpenClaw pricing, self-hosting, privacy and coding workflows. Both are free and open source; they organise work differently.",
        theirPitch: "OpenClaw is a self-hosted AI assistant with messaging integrations, memory, scheduled work and tools for browser, terminal and file tasks.",
        verdict: [
            "Choose OpenClaw for a continuing assistant across chat channels and personal workflows. Choose intentic when the main job is repository work with separate branches and a review step before changes land.",
            "OpenClaw can write code and use sandboxes. The distinction is a purpose-built coding workspace, not whether one product has tools and the other does not.",
        ],
        overlap: { title: "Free, self-hosted agents with real tools", body: "Both can automate tasks and interact with files and services. Model calls can still go to hosted providers. Neither an open-source licence nor local conversation storage is an automatic privacy or safety guarantee." },
        differences: [
            { title: "Personal continuity or repository review", body: "OpenClaw combines memory and messaging with actions across your services. intentic organises repository tasks, per-conversation worktrees and owner-reviewed landing. Choose based on whether the result is ongoing assistance or changes you need to inspect and merge." },
            { title: "OpenClaw security needs configuration", body: "OpenClaw sandboxing is disabled initially. When enabled, tool execution uses the configured backend; elevated execution can bypass it. intentic runs tasks in a sandbox, but permissions, secrets and model routing still need deliberate setup. A worktree alone is not a security boundary." },
            { title: "Pricing and self-hosted privacy", body: "OpenClaw has no project subscription charge. intentic is also free to self-host. Model access, hardware and third-party services are separate. For privacy, trace both tool execution and model requests instead of assuming locally stored memory means code never leaves." },
        ],
        table: [
            { label: "Software price and licence", intentic: "Free MIT workspace", them: "Free MIT assistant" },
            { label: "Main workflow", intentic: "Repository tasks and accepting code changes", them: "Continuing assistance across messaging and services", theirs: true },
            { label: "Memory and channels", intentic: "Workspace/task context and connected channels", them: "Personal-assistant memory and broad messaging integrations", theirs: true },
            { label: "Coding tools", intentic: "Supported coding runtimes, terminals and review", them: "Shell, files, browser and extensible tools" },
            { label: "Work isolation", intentic: "Sandbox environment plus per-conversation Git worktrees", them: "Optional tool sandbox; session separation is not file isolation" },
            { label: "Model privacy", intentic: "Depends on runtime, model endpoint and tool configuration", them: "Depends on model provider, channels and tool configuration" },
        ],
        together: { title: "Let an assistant request coding work", body: "An OpenClaw workflow that can call a webhook can start a configured intentic automation. The coding task can then produce changes for review. This requires setup and access controls; it is not a claim that every OpenClaw skill has a built-in intentic integration." },
        pickThem: "Pick OpenClaw if messaging, memory and personal workflows matter more than a dedicated code-review workspace. Its coding and sandbox tools can be useful too. You may not need intentic unless managing branches, task environments and accepted changes becomes a distinct requirement.",
        faq: [
            { question: "Is OpenClaw free and open source?", answer: "Yes. OpenClaw is MIT-licensed and has no project subscription fee. Model providers, hardware and third-party hosting can charge separately. intentic is also free MIT software to self-host; optional hosted machines and AI usage are separate costs." },
            { question: "Is intentic a self-hosted OpenClaw alternative?", answer: "For coding work, yes: it provides a self-hosted workspace around agents and repository review. For a continuing personal assistant across chat apps, OpenClaw is a closer fit. The products overlap in tools and automation, but are not interchangeable in every workflow." },
            { question: "OpenClaw vs Hermes Agent: what should I compare?", answer: "Both are free, self-hosted assistants with memory, tools and messaging workflows. Compare channel support, reusable skills, execution backends and the model configuration you want. intentic is the more specialised option when repository tasks and reviewed landing are the main goal." },
            { question: "Can OpenClaw write code and run in a sandbox?", answer: "Yes. It can use shell, file and browser tools, and supports configured sandbox backends. Sandboxing is initially disabled, and elevated tools can bypass it. Session separation is not the same as a separate filesystem or Git branch for every task." },
            { question: "Is OpenClaw private and secure because it is self-hosted?", answer: "Not automatically. Conversation state may live on your hardware, while prompts reach model providers and messages reach chat services. Review permissions, sandbox settings and external connections. Local execution, local inference and local storage are separate questions." },
            { question: "What is a free OpenClaw alternative for coding?", answer: "For an agent, compare OpenCode or Codex CLI. For a workspace around coding agents, compare intentic, T3 Code or Synara. For a continuing assistant, compare Hermes Agent. Free software does not eliminate model or hosting costs." },
        ],
        sources: [
            { label: "Repository and licence", url: "https://github.com/openclaw/openclaw" },
            { label: "Sandboxing", url: "https://docs.openclaw.ai/gateway/sandboxing" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "OpenClaw Alternatives for Coding & Self-Hosting | intentic", description: "Compare OpenClaw vs intentic: free MIT software, pricing, self-hosting, privacy, sandboxing and code review. Learn when OpenClaw or Hermes is the better fit.", datePublished: PUBLISHED },
    },
    {
        slug: "hermes",
        name: "Hermes Agent",
        url: "https://hermes-agent.nousresearch.com/",
        navLabel: "intentic vs Hermes Agent",
        menuBlurb: "Compare Hermes memory, skills and execution backends with repository-focused task review.",
        family: "assistants",
        heading: "Hermes Agent alternatives for coding and self-hosting",
        sub: "Compare Hermes Agent pricing, local models, privacy and OpenClaw. This guide covers the MIT-licensed agent from Nous Research, not unrelated Hermes hosting services.",
        theirPitch: "Hermes Agent combines persistent memory, reusable skills, scheduled jobs and coding tools across terminal, desktop and messaging interfaces.",
        verdict: [
            "Choose Hermes Agent for an assistant that remembers work and reuses skills across conversations. Choose intentic for a repository workspace with separate working branches and explicit review before changes reach the main checkout.",
            "Hermes is already free, open source and capable of coding on local or remote backends. intentic's advantage is the workflow around repository tasks, not exclusive access to tools or self-hosting.",
        ],
        overlap: { title: "Both can code and automate work", body: "Hermes supports files, terminals, browsers, delegation and cron jobs. intentic supplies coding-agent workflows and scheduled/event-driven tasks. Compare the work organisation and review boundary, not just a list of tools." },
        differences: [
            { title: "Memory and skills, or branches and review", body: "Hermes keeps persistent memory and adapts reusable skills. That is not the same as retraining model weights. intentic centres task conversations, Git worktrees and acceptance of changes. An assistant's continuity and a coding workspace's review process serve different needs." },
            { title: "Execution backends and isolation", body: "Hermes supports local, Docker, SSH and managed sandbox backends. Its documented Docker mode shares one container across the process, including delegated agents. intentic separates conversations with worktrees inside a sandbox. Filesystem isolation and Git isolation are not interchangeable." },
            { title: "Hermes pricing and local models", body: "The MIT agent is free. Optional Nous Portal plans and hosting are separate services. Hermes can use configurable providers and local-model setups. intentic is also free to self-host; the chosen runtime and backend determine model charges and where prompts go." },
        ],
        table: [
            { label: "Software licence", intentic: "MIT", them: "MIT" },
            { label: "Continuity", intentic: "Repository task and workspace history", them: "Persistent memory and reusable, evolving skills", theirs: true },
            { label: "Execution backends", intentic: "Sandbox on chosen hardware or optional hosting", them: "Local, Docker, SSH and multiple managed backends", theirs: true },
            { label: "Parallel code changes", intentic: "Per-conversation worktree with review before landing", them: "Delegation and coding tools; Git workflow is up to your setup" },
            { label: "Recurring work", intentic: "Schedules and service events", them: "Cron jobs with messaging delivery" },
            { label: "Running costs", intentic: "Model usage and optional hosted compute", them: "Model access and optional Portal/hosting" },
        ],
        together: { title: "Keep the assistant and delegate repository work", body: "If your Hermes setup can make an authenticated webhook request, it can start a configured intentic automation. Keep assistant continuity in Hermes and review repository changes in intentic. Build and permission that integration explicitly rather than assuming it ships ready to use." },
        pickThem: "Pick Hermes Agent if long-term memory, reusable skills and cross-channel assistance are central to your work. Its configurable models and execution backends are real strengths. A separate coding workspace is useful only if you need stronger task organisation and review around repository changes.",
        faq: [
            { question: "Is Hermes Agent free and open source?", answer: "Yes. Nous Research's Hermes Agent is free MIT-licensed software. Optional Nous Portal plans, model usage and hosting are separate. Do not confuse a third-party Hermes hosting price with a mandatory subscription for the agent." },
            { question: "How much does Hermes Agent cost?", answer: "The agent has no software subscription fee. The homepage lists optional Nous Portal tiers at $0, $20, $100 and $200 per month. These are service plans, not a licence requirement. Your model backend and hosting choice determine the full running cost." },
            { question: "Can Hermes Agent use local models and be self-hosted?", answer: "Yes. Hermes supports configurable providers and local-model setups, and several execution backends including local, Docker and SSH. Self-hosting tools does not make a configured cloud model or external service local. Check each connection separately." },
            { question: "Hermes Agent vs OpenClaw: which is better?", answer: "Both are self-hosted assistants with memory, tools and messaging. Compare the channels, skill system, execution backends and controls you need. Neither is automatically a purpose-built multi-agent code-review workspace. intentic is worth comparing when accepted repository changes are the main output." },
            { question: "Is Hermes Agent private because it runs locally?", answer: "Local state can stay on your host, but model calls and third-party tools can still send data elsewhere. Check the selected backend, provider policy and credentials. A Docker container protects execution differently from a separate Git worktree; neither alone guarantees privacy." },
            { question: "What is a Hermes Agent alternative for coding?", answer: "OpenCode or Codex CLI are options for a coding agent. intentic is an option for a workspace around supported agents, with separate branches and reviewed landing. Hermes itself can code, so switch only if the repository workflow—not simply tool access—is what you need to improve." },
            { question: "Hermes Agent vs Claude Code: which is for coding?", answer: "Both can code. Claude Code focuses on coding-agent workflows; Hermes combines coding tools with assistant memory, reusable skills and messaging. intentic can run Claude Code in a repository workspace. Choose based on the work organisation and review process you need." },
        ],
        sources: [
            { label: "Source, models and licence", url: "https://github.com/NousResearch/hermes-agent" },
            { label: "Tools and execution backends", url: "https://hermes-agent.nousresearch.com/docs/user-guide/features/tools" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Hermes Agent Alternatives: Pricing & Self-Hosting | intentic", description: "Compare Hermes Agent vs intentic and OpenClaw. Check free MIT licensing, pricing, local models, privacy, execution backends and repository review workflows.", datePublished: PUBLISHED },
    },
    {
        slug: "cloud-agents",
        name: "Cloud coding agents",
        url: "https://jules.google/",
        navLabel: "intentic vs cloud coding agents",
        menuBlurb: "Compare managed cloud agents with an always-on, self-hosted coding workspace.",
        family: "cloud",
        heading: "Cloud coding agent alternatives: managed vs self-hosted",
        sub: "Compare Devin, Jules, Codex cloud, Claude Code and Cursor cloud agents with a workspace on your own machine. Check pricing, privacy and maintenance separately.",
        theirPitch: "Cloud coding agents run repository tasks remotely and return changes or pull requests. Products differ in hosting, models, review controls and data policies.",
        verdict: [
            "Choose managed cloud agents when you want asynchronous coding without maintaining the execution environment. Choose intentic when you want a shared browser workspace on hardware you choose, with supported agent and provider options.",
            "Self-hosting is not automatically cheaper or more private. Include compute, model usage and maintenance in the decision. Some cloud products also offer customer-hosted workers, so this is not a simple cloud-versus-local divide.",
        ],
        overlap: { title: "Both can work while your laptop is off", body: "A managed cloud agent can keep running remotely. intentic can too if its sandbox is on an always-on server or hosted machine. Both can produce changes for human review; neither makes code correct merely by opening a pull request." },
        differences: [
            { title: "Local vs cloud execution", body: "Jules uses a cloud VM; Codex cloud uses task workspaces. intentic runs agent tools on the chosen sandbox host. Devin Outposts and Cursor self-hosted machines are important exceptions: execution can be customer-hosted while parts of the service remain in the vendor cloud." },
            { title: "Compare the complete running cost", body: "Managed products use different subscriptions, allowances and usage charges. intentic's self-hosted software is free, but models, hardware or rented compute may cost money. A free tier is useful for trials; it does not establish the cheapest option for your workload." },
            { title: "Privacy: trace the actual data flow", body: "Check execution location, model endpoints, transcripts and secret handling separately. Hosted models may receive code even when tools run locally. Cursor documents runtime-redacted secrets, so it is wrong to say every cloud agent necessarily sends raw credentials to the model." },
        ],
        table: [
            { label: "Setup and maintenance", intentic: "You manage a host, or choose optional hosting", them: "Managed environments reduce infrastructure work", theirs: true },
            { label: "Execution", intentic: "Your sandbox host", them: "Vendor cloud; customer-hosted options on some products" },
            { label: "Always-on jobs", intentic: "Use an always-on sandbox", them: "Remote jobs continue independently of a laptop", theirs: true },
            { label: "Agent choice", intentic: "Supported runtimes and their provider configurations", them: "Product-specific agents, models and integrations" },
            { label: "Review", intentic: "Review before landing in the owner's checkout", them: "Product-specific diffs, revisions and pull requests" },
            { label: "Privacy", intentic: "Depends on model/tool routing as well as hosting", them: "Depends on service policy, deployment and secret controls" },
        ],
        pickThem: "Pick managed cloud agents if avoiding environment maintenance is worth the price and their model, access and data controls meet your requirements. Test the review process and reliability on your own repository. Owning infrastructure is useful, but it is also work.",
        faq: [
            { question: "Which cloud coding agent is best?", answer: "There is no universal best. Compare Devin, Jules, Codex cloud, Claude Code and Cursor on the same repository task. Look at setup, test results, revisions, pricing and data policies. intentic is an alternative when owning the workspace and choosing supported runtimes matters more than turnkey hosting." },
            { question: "Are there free, open-source cloud coding agent alternatives?", answer: "OpenHands is an open-source agent option; intentic, T3 Code and Synara offer open-source workspaces around agents. You still need model access and compute. Some managed services have free tiers, but their limits and licences differ. Free software is not free hosting." },
            { question: "Can I self-host coding agents that work while my laptop is off?", answer: "Yes. Run a supported agent workspace on an always-on server or hosted machine. intentic gives browser access to that workspace. If the sandbox lives on the laptop you turn off, the jobs stop too; self-hosting does not remove the need for running hardware." },
            { question: "Do self-hosted agents keep all code and credentials local?", answer: "Not necessarily. Hosted inference may receive code or tool results. External tools and messaging services create other data paths. Inspect the runtime, model configuration, logs and secret handling. Execution on your hardware is only one part of the privacy boundary." },
            { question: "Codex vs Jules vs Claude Code: what should I compare?", answer: "Compare repository setup, supported models, triggers, human review and current usage limits. Jules documents a cloud-VM workflow; Codex and Claude Code also have local interfaces. Do not assume features, quotas or data policies are the same across local and hosted versions." },
            { question: "Can a cloud coding agent run on my own infrastructure?", answer: "Sometimes. Devin Outposts and Cursor self-hosted machines support customer-hosted execution, while planning or inference can remain hosted. intentic runs its workspace on your chosen host. Ask where tools, model requests and stored task records go—not just whether a product says self-hosted." },
        ],
        sources: [
            { label: "Codex cloud overview", url: "https://learn.chatgpt.com/docs/cloud" },
            { label: "Cursor cloud security", url: "https://prod.cursor.com/docs/cloud-agent/security" },
            { label: "Cursor self-hosted machines", url: "https://cursor.com/docs/cloud-agent/self-hosted" },
            { label: "Devin Outposts", url: "https://docs.devin.ai/cloud/outposts/overview" },
            { label: "OpenHands project", url: "https://github.com/OpenHands/OpenHands" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Cloud Coding Agent Alternatives: Self-Hosted | intentic", description: "Compare cloud coding agents with self-hosted alternatives. Explore Devin, Jules, Codex and Claude Code workflows, pricing, privacy, review and always-on jobs.", datePublished: PUBLISHED },
    },
    {
        slug: "devin",
        name: "Devin",
        url: "https://devin.ai/",
        navLabel: "intentic vs Devin",
        menuBlurb: "Compare Devin's managed engineering workflow and Outposts with a self-hosted, multi-runtime workspace.",
        family: "cloud",
        heading: "Devin alternatives: free and self-hosted workspaces",
        sub: "Compare Devin pricing, Outposts, privacy and open-source alternatives. intentic is a workspace for supported coding agents, not a clone of Devin's agent.",
        theirPitch: "Devin is an engineering agent with cloud, desktop and CLI workflows, code review, integrations and customer-hosted execution through Outposts.",
        verdict: [
            "Choose Devin for an integrated engineering service with managed cloud sessions and team integrations. Choose intentic if you want to operate the workspace yourself and choose among supported agent runtimes.",
            "Devin can run tools on customer infrastructure through Outposts. The distinction is who controls the workspace, agent and inference—not an outdated claim that Devin can only execute on vendor machines.",
        ],
        overlap: { title: "Both produce changes for review", body: "Both support repository work, tests and automation. Devin provides code review and pull-request workflows. intentic uses per-conversation worktrees and owner-reviewed landing. Human review is necessary in either setup." },
        differences: [
            { title: "Devin pricing: read the current plan", body: "Devin's Desktop page lists Free, Pro at $20/month and Max at $200/month. Teams is $80/month plus $40/month per full seat. These displayed subscriptions do not imply unlimited cloud jobs. intentic is free to self-host; model and optional compute costs remain." },
            { title: "What Devin Outposts self-hosts", body: "Outposts moves repository access, commands and file edits onto customer machines. Devin still hosts inference, planning and the session queue. With intentic, you run the workspace on your chosen host and configure supported runtimes; hosted models may still receive code." },
            { title: "Turnkey service or runtime choice", body: "Devin combines its own agent, cloud sessions, review and Slack/Teams entry points. intentic lets different supported agents work in one browser workspace. More choice is useful when you need it, but a managed service can reduce setup and maintenance." },
        ],
        table: [
            { label: "Main offering", intentic: "Workspace around supported coding runtimes", them: "Integrated engineering agent and service" },
            { label: "Software costs", intentic: "Free MIT workspace; provider/hosting costs separate", them: "Free and paid plans; usage and quotas depend on tier" },
            { label: "Managed cloud", intentic: "Self-host or use optional hosted machines", them: "Turnkey cloud sessions with a VM per session", theirs: true },
            { label: "Customer infrastructure", intentic: "Run the workspace and agent tools on your host", them: "Outposts executes tools locally; inference/planning stay hosted" },
            { label: "Team workflow", intentic: "Shared workspace, connected services and reviewed landing", them: "Integrated engineering, code review and Slack/Teams workflows", theirs: true },
            { label: "Agent choice", intentic: "Choose supported runtimes per conversation", them: "Devin's own agent workflow" },
        ],
        pickThem: "Pick Devin if you want one managed engineering product and its cloud sessions, code review and integrations fit your team. Outposts may suit customer-hosted execution requirements without abandoning the service. Choose intentic when runtime choice and operating your own workspace are worth the extra setup.",
        faq: [
            { question: "What is a free, open-source Devin alternative?", answer: "OpenHands is an open-source coding-agent option. intentic is a free MIT-licensed workspace around supported agents, not a reimplementation of Devin's agent. Model usage and compute can cost money in either open-source setup. Compare the workflow as well as the licence." },
            { question: "How much does Devin cost?", answer: "The current Desktop page lists Free at $0, Pro at $20/month, Max at $200/month, and Teams at $80/month plus $40 per full seat. Enterprise pricing is quoted separately. Check cloud allowances and usage terms; those subscription prices are not a promise of unlimited work." },
            { question: "Can Devin be self-hosted with Outposts?", answer: "Outposts runs commands, file edits and repository access on customer infrastructure. Inference, planning and the session queue remain in Devin's cloud. It is not a fully offline self-hosted copy of the service. Current access and setup requirements are documented per plan and deployment." },
            { question: "Devin vs OpenHands: what is the main trade-off?", answer: "Devin offers an integrated commercial service; OpenHands is an open-source agent option. The relevant questions are deployment effort, model choice, actual task performance and review. intentic is another option at the workspace level, managing supported agents rather than replacing their behavior." },
            { question: "Is Devin private when it runs on my infrastructure?", answer: "Outposts controls where tools execute, but task context still reaches Devin for planning and inference. Read the service's data and deployment terms separately. intentic also needs a deliberate model/tool configuration; self-hosting alone does not mean prompts never leave the machine." },
            { question: "Devin vs intentic: which should I choose?", answer: "Choose Devin for its managed agent service and integrated engineering workflow. Choose intentic for an MIT workspace you operate, with supported runtime choice and reviewed landing. Test both on a representative task and count model usage, compute and maintenance in the cost." },
            { question: "Devin vs Cursor or Claude Code: what is different?", answer: "Devin provides an integrated engineering service, including managed cloud work. Cursor includes an editor, while Claude Code centres its coding-agent workflow. These products have overlapping agent features. Compare interfaces, actual task results and deployment needs rather than assuming one is universally more autonomous." },
        ],
        sources: [
            { label: "Desktop and current pricing", url: "https://devin.ai/desktop" },
            { label: "Outposts overview", url: "https://docs.devin.ai/cloud/outposts/overview" },
            { label: "OpenHands alternative", url: "https://github.com/OpenHands/OpenHands" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Devin Alternatives: Free & Self-Hosted Options | intentic", description: "Compare Devin vs intentic: current pricing, open-source alternatives, Outposts, privacy and code review. Choose a managed service or a workspace you run yourself.", datePublished: "2026-09-22" },
    },
    {
        slug: "github-copilot",
        name: "GitHub Copilot",
        url: "https://github.com/features/copilot",
        navLabel: "intentic vs GitHub Copilot",
        menuBlurb: "Compare editor completions, GitHub cloud agents and local models with a shared agent workspace.",
        family: "editors",
        heading: "GitHub Copilot alternatives: where intentic fits",
        sub: "Compare Copilot pricing, free and open-source alternatives, local models and self-hosting. intentic does not replace an inline completion extension.",
        theirPitch: "GitHub Copilot provides editor suggestions, chat, local agent tools, a terminal CLI and cloud workflows built around GitHub repositories and pull requests.",
        verdict: [
            "Choose Copilot for AI help inside your editor and GitHub-centred agent workflows. Choose intentic when you want a shared browser workspace across supported coding runtimes and machines.",
            "Copilot now supports bring-your-own models, including local endpoints on supported surfaces. intentic is not the only path to local inference, scheduling or parallel work.",
        ],
        overlap: { title: "Both support tasks and human review", body: "Copilot's cloud agent works through branches and pull requests, with review controls and scheduled/event-driven automations. intentic uses worktrees and owner-reviewed landing. Neither removes the need to check generated code." },
        differences: [
            { title: "Inline completions or a shared workspace", body: "Copilot is a closer fit if you want suggestions while typing in VS Code or another supported IDE. intentic focuses on assigning tasks, managing environments and accepting agent changes. Keep Copilot in your editor if those features still help." },
            { title: "Copilot pricing and free options", body: "Copilot Free has limits. Pro is $10/month and Pro+ is $39/month; usage credits and cloud-related charges depend on the plan. Supported BYOK workflows can work without a Copilot subscription. intentic is free MIT software, with model and optional hosting costs separate." },
            { title: "Local models do not self-host all of GitHub", body: "Copilot CLI documents local providers such as Ollama and compatible endpoints. That is not a self-hosted copy of the GitHub cloud agent. intentic hosts its workspace on your chosen machine; local inference still depends on the agent and endpoint you configure." },
        ],
        table: [
            { label: "Typing-time assistance", intentic: "Not an inline completion extension", them: "Completions and chat inside supported IDEs", theirs: true },
            { label: "Workspace licence", intentic: "MIT", them: "Commercial service; CLI has a separate custom licence" },
            { label: "Starting costs", intentic: "Free self-hosted workspace; models/hosting separate", them: "Limited Free tier; Pro $10/month; BYOK has separate terms" },
            { label: "GitHub workflow", intentic: "Connect GitHub alongside other workspace services", them: "Integrated issue, branch, review and PR workflows", theirs: true },
            { label: "Local inference", intentic: "Use a supported agent with a local backend", them: "Supported BYOK surfaces can use local endpoints" },
            { label: "Cloud execution", intentic: "Your running sandbox or optional hosted machine", them: "Cloud agent in a temporary GitHub Actions environment" },
        ],
        together: { title: "Keep Copilot in your editor", body: "Use Copilot for completions and editor tasks, then use intentic for longer work with its supported runtimes. The shared repository is the connection. This is not a claim that intentic runs the Copilot runtime as a built-in agent or replaces Copilot's GitHub-specific features." },
        pickThem: "Pick Copilot if your team lives in GitHub and you want integrated editor, issue and pull-request workflows. Its low entry price, free tier and supported local BYOK options are worth evaluating. Add intentic when a broader workspace across agents and machines is genuinely useful.",
        faq: [
            { question: "Is intentic a free, open-source GitHub Copilot alternative?", answer: "It is a free MIT workspace for agent-led coding, not a drop-in autocomplete extension. If you want to replace inline suggestions, compare editor-focused tools such as the self-hosted Tabby server and VS Code extension. If you want to manage coding tasks across supported agents, intentic is a relevant alternative. Model and hosting costs remain separate." },
            { question: "What does GitHub Copilot cost?", answer: "Copilot offers a limited Free tier. Individual Pro is $10/month and Pro+ is $39/month; other individual and team plans have different credits and limits. Cloud work can also involve Actions usage. Check current allowances rather than relying on old premium-request counts." },
            { question: "Can GitHub Copilot use local models?", answer: "Yes, on supported BYOK surfaces. The CLI documents Ollama, vLLM, Foundry Local and compatible endpoints. A supported local endpoint can avoid hosted model calls. GitHub's offline flag does not stop traffic to a remote provider you configure, so inspect the actual setup." },
            { question: "Can I self-host GitHub Copilot?", answer: "Local CLI execution and local BYOK do not mean you can self-host the entire GitHub cloud-agent service. If you need an owner-operated workspace, compare intentic. If you only need local model inference, Copilot's supported BYOK workflow may already solve that problem." },
            { question: "Copilot vs Cursor, Claude Code or Codex: what changes?", answer: "Copilot centres supported editors and GitHub. Cursor includes its own editor; Claude Code and Codex provide agent-led coding workflows across several interfaces. Test the task and review experience, not just a feature count. intentic manages supported runtimes without replacing all these editor features." },
            { question: "Can I use Copilot alongside intentic?", answer: "Yes. Keep Copilot in your editor and use intentic's supported agents for other repository tasks. Review and coordinate changes through Git. This does not imply Copilot is a built-in intentic runtime or that its subscription and service terms stop applying." },
        ],
        sources: [
            { label: "Plans and pricing", url: "https://github.com/features/copilot/plans" },
            { label: "Cloud coding agent", url: "https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent" },
            { label: "Bring your own models", url: "https://docs.github.com/en/copilot/concepts/models/bring-your-own-key" },
            { label: "CLI local providers", url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models" },
            { label: "CLI licence", url: "https://github.com/github/copilot-cli/blob/main/LICENSE.md" },
            { label: "Tabby completion alternative", url: "https://github.com/TabbyML/tabby" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "GitHub Copilot Alternatives: Free & Open Source | intentic", description: "Compare GitHub Copilot vs intentic: free alternatives, pricing, local models, self-hosting and GitHub workflows. Learn when to keep Copilot in your editor.", datePublished: "2026-09-22" },
    },
    {
        slug: "codex",
        name: "Codex",
        url: "https://learn.chatgpt.com/docs",
        navLabel: "intentic vs Codex",
        menuBlurb: "Codex CLI is already open source. Compare local and cloud use, or run the native agent inside intentic.",
        family: "harnesses",
        heading: "Codex alternatives—and how intentic runs Codex",
        sub: "Compare OpenAI Codex pricing, free access, local models and cloud tasks. Codex CLI is open source; intentic adds a shared workspace around the agent.",
        theirPitch: "Codex is OpenAI's coding agent, with CLI, app, IDE and cloud workflows for repository tasks. Its CLI is open source and supports local model backends.",
        verdict: [
            "Keep Codex if you like its coding agent. Use it directly for terminal, app or cloud work, or run the native agent in intentic for shared environments, other runtimes and owner-reviewed landing.",
            "If you need a different agent, compare Claude Code or OpenCode. intentic is not a replacement model, and Codex CLI already offers open-source code and local-model support.",
        ],
        overlap: { title: "Parallel tasks and review are shared capabilities", body: "Codex supports concurrent tasks and subagents. Cloud jobs can return changes and test results for review or pull requests. intentic also supports parallel work; its added value is the broader workspace and acceptance process." },
        differences: [
            { title: "Codex CLI, cloud service and workspace", body: "Codex CLI uses Apache 2.0. The hosted cloud service and IDE extension are not open-source copies of that CLI. intentic's workspace uses MIT. Compare the specific surface you need rather than treating every Codex product as one licence or deployment." },
            { title: "Codex pricing and free access", body: "Free-plan access is rollout-dependent; paid plans have different allowances. Plus is $20/month, while API access is metered separately and does not include cloud integrations. Local and cloud subscription usage can share limits. intentic does not change those provider rules." },
            { title: "Local models or cloud execution", body: "Codex CLI supports Ollama and LM Studio through its local-provider options. Codex cloud runs tasks remotely. intentic can host native Codex on a chosen machine. Running tools locally does not mean OpenAI requests or every external tool stay offline." },
        ],
        table: [
            { label: "Main role", intentic: "Workspace around supported coding agents", them: "Codex agent across terminal, app and hosted interfaces" },
            { label: "Open-source licence", intentic: "MIT workspace", them: "Apache 2.0 CLI; hosted service/IDE terms separate" },
            { label: "Local models", intentic: "Use a supported runtime with a local backend", them: "CLI supports Ollama and LM Studio" },
            { label: "Direct agent interface", intentic: "Browser workspace and task controls", them: "Native CLI and app workflows", theirs: true },
            { label: "Managed cloud", intentic: "Choose an always-on host or optional hosting", them: "Remote task workspaces and PR workflow", theirs: true },
            { label: "Runtime choice", intentic: "Codex alongside other supported agents", them: "Codex's agent behavior and supported providers" },
        ],
        together: { title: "Run native Codex inside intentic", body: "Bring eligible ChatGPT or configured provider access and keep the Codex runtime. intentic adds its sandbox environment, shared browser interface and review-before-landing step. Your Codex allowances, model capabilities and provider terms remain in force." },
        pickThem: "Use Codex directly if its terminal, app or managed cloud workflow already fits. It is especially useful when you want OpenAI's agent without maintaining another workspace. Add intentic when sharing, environment management or coordinating several runtimes becomes the harder problem.",
        faq: [
            { question: "Is Codex free and open source?", answer: "Codex CLI is free Apache 2.0 software. That does not make hosted models or every Codex product free or open source. Free-plan service access can depend on rollout and limits. Cloud and IDE offerings have separate terms; local models have their own licences and hardware costs." },
            { question: "How much does OpenAI Codex cost?", answer: "Codex has access through eligible ChatGPT plans, with plan-specific limits; Plus is $20/month. API-key access is separately metered and does not include cloud integrations. Free access and app availability can vary during rollout. Check the current pricing page for your exact surface and allowance." },
            { question: "Can Codex run local models?", answer: "Yes. Codex CLI supports local-provider setups such as Ollama and LM Studio, including its OSS mode. This is not the same as running OpenAI's hosted Codex model weights locally. Results and supported tools depend on the chosen model and configuration." },
            { question: "Can I self-host Codex, and how does local differ from cloud?", answer: "You can run the open-source CLI on your own host, including in intentic. Codex cloud is a managed service with remote task workspaces. A local CLI using a hosted model still sends inference requests out. The software licence, execution host and model endpoint are separate choices." },
            { question: "Codex vs Claude Code or Cursor: which should I use?", answer: "Cursor includes an editor; Codex and Claude Code provide agent-led coding across several surfaces. Compare actual task results, costs, interfaces and review controls. intentic can run these supported runtimes side by side, so different tasks need not use the same agent." },
            { question: "Is intentic a Codex alternative or a way to run it?", answer: "It is a workspace that can run native Codex, not a clone of the agent. It also supports other runtimes, so you can switch agents when useful. If Codex alone handles your workflow, you do not need to add another workspace." },
        ],
        sources: [
            { label: "Pricing", url: "https://learn.chatgpt.com/docs/pricing" },
            { label: "Cloud tasks", url: "https://learn.chatgpt.com/docs/cloud" },
            { label: "Local providers and configuration", url: "https://learn.chatgpt.com/docs/config-file/config-advanced" },
            { label: "Open-source scope", url: "https://learn.chatgpt.com/docs/open-source" },
            { label: "CLI licence", url: "https://github.com/openai/codex/blob/main/LICENSE" },
        ],
        verifiedOn: "2026-10-04",
        meta: { title: "Codex Alternatives: Free, Local & Open Source | intentic", description: "Compare OpenAI Codex alternatives, pricing, free access and local models. Learn how CLI and cloud differ, and when to run native Codex inside intentic.", datePublished: "2026-09-22" },
    },
];

export const comparePage = (slug: string): ComparePage | undefined => comparePages.find((page) => page.slug === slug);

export const familyPages = (id: string): ComparePage[] => comparePages.filter((page) => page.family === id);

export const compareIndex = {
    eyebrow: "AI coding tool comparisons",
    heading: "Compare AI coding tools and self-hosted alternatives",
    sub: "Looking for a Cursor alternative, a Claude Code workspace or a way to run several agents? Compare pricing, open-source licences, local models and remote work. Each guide explains where intentic fits—and when another tool is the better choice.",
    axes: {
        heading: "How to choose an AI coding tool",
        items: [
            {
                title: "Choose the workflow first",
                body: "For suggestions while you type, choose an AI editor or completion tool. For tasks that produce code changes, choose a coding agent. For several agents, shared reviews and recurring work, compare coding workspaces. The best tool is the one that fits your actual work.",
            },
            {
                title: "Separate software, models and machines",
                body: "Free software does not always mean free AI usage. Check the model bill and hosting cost separately. Local execution does not mean local inference: a tool running on your laptop may still send code to a hosted model. Read the deployment and data policies before choosing.",
            },
        ],
    },
    faq: [
        {
            question: "Which AI coding tool is best for developers?",
            answer: "There is no universal winner. Cursor and Copilot suit editor-first work. Claude Code, Codex and OpenCode suit agent-led tasks. Conductor, Superset, T3 Code, Synara, Nimbalyst and intentic help manage multiple sessions. Compare the tools on a real task in your own repository.",
        },
        {
            question: "Are there free, open-source AI coding tools?",
            answer: "Yes. OpenCode, T3 Code, Synara and intentic use MIT licences; Codex CLI uses Apache 2.0. Nimbalyst's desktop and iOS code is MIT-licensed. Models, hosted services and collaboration backends can have different licences and charges. Check those separately.",
        },
        {
            question: "What is a self-hosted AI coding workspace?",
            answer: "It runs the workspace and agent tools on a machine you control, such as a laptop or server. intentic is free to self-host and gives you browser access to that machine. Hosted model requests can still leave it; self-hosting alone is not an offline guarantee.",
        },
        {
            question: "Can I run multiple coding agents in parallel?",
            answer: "Yes. Several agents and workspaces support parallel sessions. Separate Git worktrees give each task its own branch and working directory. They reduce accidental interference, but do not eliminate merge conflicts or replace operating-system sandboxing and review.",
        },
        {
            question: "What are the best free alternatives to Cursor and Copilot?",
            answer: "That depends on what you want to replace. Tabby provides self-hosted editor completion and is a closer match for inline suggestions. OpenCode or Codex CLI can handle agent-led tasks. intentic is a free workspace around supported agents, not a drop-in autocomplete extension.",
        },
        {
            question: "Should I use local or cloud coding agents?",
            answer: "Local tools work with your existing environment. Cloud agents offer managed, asynchronous jobs. An always-on self-hosted workspace is a third option. Compare setup effort, provider choice, execution location and data handling—not just the words local and cloud.",
        },
    ] satisfies FaqEntry[],
    correction: {
        title: "Found an outdated comparison?",
        body: "Features and prices change quickly. Detail pages list the official sources and the date they were checked. If something is wrong, send us the current source.",
        cta: "Report a correction",
    },
    meta: {
        title: "AI Coding Tools Compared: Open-Source Alternatives | intentic",
        description: "Compare AI coding agents, editors and workspaces. Find free, open-source and self-hosted alternatives to Cursor, Copilot, Claude Code, Devin and more.",
        datePublished: PUBLISHED,
    },
};
