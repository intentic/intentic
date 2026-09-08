import { type Book, bookDestinations, bookHref, bookPages } from "./book";

// /docs is written for someone using intentic, not authoring it (that's /developers). Sections are shelved by what the
// reader is asking (what is this, running the machine, wiring outside systems in, daily work), not by lifecycle stage.
// No shelf run exceeds five rows; a longer one takes a sub-heading.
export const docsBook: Book = {
    id: "docs",
    label: "Docs",
    sections: [
        {
            label: "Understand",
            tagline: "What this is",
            icon: "book-open",
            entry: "",
            groups: [
                {
                    items: [
                        {
                            id: "",
                            title: "Overview",
                            blurb: "What intentic is and where to start",
                            meta: {
                                title: "intentic docs · Overview",
                                description:
                                    "How intentic gives agents a specialized sandbox workspace on hardware you choose, and where to start in the docs.",
                                datePublished: "2026-07-23",
                            },
                        },
                        {
                            id: "architecture",
                            title: "Architecture",
                            blurb: "Where identity, code, control, state and compute live",
                            meta: {
                                title: "Architecture · intentic docs",
                                description:
                                    "How intentic fits together: the thin platform, the sandbox daemon, direct browser control, durable state, agent execution, child agents and remote runners.",
                                datePublished: "2026-07-23",
                            },
                        },
                        {
                            // First shelf: later pages rely on these words (daemon, land, worktree, harness) from early
                            // on.
                            id: "glossary",
                            title: "Glossary",
                            blurb: "Every word these docs use as if you knew it",
                            meta: {
                                title: "Glossary · intentic docs",
                                description:
                                    "What intentic means by daemon, sandbox, definition, bundle, runner, conversation, child agent, worktree, landing, harness, capability and control token.",
                                datePublished: "2026-08-11",
                            },
                        },
                    ],
                },
            ],
        },
        {
            label: "Run a sandbox",
            tagline: "Install, reproduce, keep",
            icon: "box",
            entry: "quickstart",
            groups: [
                {
                    items: [
                        {
                            id: "quickstart",
                            title: "Quickstart",
                            blurb: "Four ways to bring a sandbox up, end to end",
                            meta: {
                                title: "Quickstart · intentic docs",
                                description:
                                    "Bring a live agent workspace up on your own machine four ways: the desktop app, one setup command, Docker Compose, or plain docker run.",
                                datePublished: "2026-07-23",
                            },
                        },
                        {
                            id: "docker",
                            title: "Docker setup",
                            blurb: "What gets created, and how to live with it",
                            meta: {
                                title: "Docker setup · intentic docs",
                                description:
                                    "The anatomy every install path shares: the containers, volumes and network created, the capability posture, the nested engine, overlays and updates.",
                                datePublished: "2026-07-23",
                            },
                        },
                        {
                            id: "sandbox-definitions",
                            title: "Sandbox definitions",
                            blurb: "Export, review and reproduce an environment as TOML",
                            meta: {
                                title: "Sandbox definitions · intentic docs",
                                description:
                                    "Describe a sandbox as sandbox.toml: the workspace, repositories, connection shapes, secret names, environment overlay and agent settings, without credentials.",
                                datePublished: "2026-08-25",
                            },
                        },
                    ],
                },
                {
                    label: "Keep it",
                    items: [
                        {
                            // Kept short so the rail row doesn't wrap; the promise lives in meta.description instead.
                            id: "updates",
                            title: "Updates & rollback",
                            blurb: "The promises every update keeps, and the way back",
                            meta: {
                                title: "Updates: what we promise never breaks · intentic docs",
                                description:
                                    "What an intentic update can never touch. Your files survive every update and rollback, updates are offered not forced, and breaking changes are flagged.",
                                datePublished: "2026-08-10",
                            },
                        },
                        {
                            id: "access",
                            title: "Access & sharing",
                            blurb: "One owner, invited people, enforced tiers",
                            meta: {
                                title: "Access & sharing · intentic docs",
                                description:
                                    "How the owner is decided, what each invited tier can do, and why the daemon rather than the UI is what enforces it.",
                                datePublished: "2026-08-07",
                            },
                        },
                        {
                            // Includes agent-side symptoms too: a reader here often cannot tell which half broke.
                            id: "troubleshooting",
                            title: "Troubleshooting",
                            blurb: "What goes wrong, what causes it, what to do",
                            meta: {
                                title: "Troubleshooting · intentic docs",
                                description:
                                    "Fix a sandbox that never came up, a workspace that won't open, unattended runs that error, work that won't land, and extensions or capabilities that went quiet.",
                                datePublished: "2026-08-11",
                            },
                        },
                    ],
                },
            ],
        },
        {
            label: "Integrations",
            tagline: "Outside systems and machines",
            icon: "layers",
            entry: "capabilities",
            groups: [
                {
                    items: [
                        {
                            id: "capabilities",
                            title: "Capabilities",
                            blurb: "Give the agent tools, systems and machines",
                            meta: {
                                title: "Capabilities · intentic docs",
                                description:
                                    "Connect GitHub, databases, MCP servers, SSH hosts and more. Where the credentials live, and what the agent actually receives.",
                                datePublished: "2026-08-07",
                            },
                        },
                        {
                            // The installer's half of the extension lifecycle; building one is the other half, in
                            // /developers.
                            id: "extensions",
                            title: "Extensions",
                            blurb: "Find one, read what it may touch, install and keep it",
                            meta: {
                                title: "Install & manage extensions · intentic docs",
                                description:
                                    "Browse the gallery, read what an extension may touch before you approve it, install it pinned to an exact commit, and stay in control of every update.",
                                datePublished: "2026-08-11",
                            },
                        },
                        {
                            id: "your-machine",
                            title: "Your own machine",
                            blurb: "Sync, host tools, runners and the editor bridge",
                            meta: {
                                title: "Your own machine · intentic docs",
                                description:
                                    "Sync a folder, let an agent operate your device, use its compute as a remote runner, or drive sandbox agents from Zed or JetBrains over ACP.",
                                datePublished: "2026-08-07",
                            },
                        },
                        {
                            id: "your-browser",
                            title: "Your own browser",
                            blurb: "The extension, the sites you allow, and watching it work",
                            meta: {
                                title: "Your own browser · intentic docs",
                                description:
                                    "Install the browser extension and let your sandbox work in the browser you are already signed into: on the sites you allow, one at a time, while you watch.",
                                datePublished: "2026-08-29",
                            },
                        },
                    ],
                },
            ],
        },
        {
            label: "Drive agents",
            tagline: "The everyday work",
            icon: "workflow",
            entry: "parallel-agents",
            groups: [
                {
                    items: [
                        {
                            id: "parallel-agents",
                            title: "Parallel agents",
                            blurb: "Isolated conversations, subagents and cross-provider children",
                            meta: {
                                title: "Parallel agents · intentic docs",
                                description:
                                    "Run isolated agents in parallel, let a turn supervise runtime subagents or full cross-provider child agents, and review every branch before it lands.",
                                datePublished: "2026-08-07",
                            },
                        },
                        {
                            id: "remote-runners",
                            title: "Remote runners",
                            blurb: "Run a conversation on another computer, keep control here",
                            meta: {
                                title: "Remote runners · intentic docs",
                                description:
                                    "Place agent conversations on runner containers on your other devices while the parent sandbox keeps the transcript, branch, review and land workflow.",
                                datePublished: "2026-08-25",
                            },
                        },
                        {
                            id: "automations",
                            // Names all three (automations, workflows, loops); still the longest row, but fits on one
                            // line.
                            title: "Automations, workflows & loops",
                            blurb: "Work that starts without you, multi-step runs, and repeating until it's right",
                            meta: {
                                title: "Automations, workflows & loops · intentic docs",
                                description:
                                    "Wake an agent on a schedule, a webhook or a message; run several agents in order as a workflow; or loop one until the goal is met.",
                                datePublished: "2026-08-07",
                            },
                        },
                        {
                            id: "models",
                            title: "Models & accounts",
                            blurb: "Providers, harnesses, accounts and what they cost",
                            meta: {
                                title: "Models & accounts · intentic docs",
                                description:
                                    "Which model serves a turn: the provider, the connected account, the agentic loop it runs in, and where the spend is reported.",
                                datePublished: "2026-08-07",
                            },
                        },
                    ],
                },
                {
                    // Worked examples: a whole thing built from the pages above, not one surface explained alone.
                    label: "Worked examples",
                    items: [
                        {
                            id: "front-desk",
                            title: "Front Desk",
                            blurb: "Put a chat on your website, answered by your agent",
                            meta: {
                                title: "Front Desk · put your agent on your website · intentic docs",
                                description:
                                    "Embed a chat widget on your site with one script tag. Visitors talk to your sandbox agent; you watch and take over from the fleet board.",
                                datePublished: "2026-08-01",
                            },
                        },
                        {
                            id: "bug-reports",
                            title: "Bug reports",
                            blurb: "Your users' crashes, fixed by your agent",
                            meta: {
                                title: "Bug reports · crashes fixed by your agent · intentic docs",
                                description:
                                    "Embed a crash reporter with one script tag. Reports are grouped, so a crash that hit a thousand people is one issue your agent investigates once.",
                                datePublished: "2026-08-30",
                            },
                        },
                        {
                            id: "autonomous-employees",
                            title: "Autonomous employees",
                            blurb: "Specialize a sandbox until it does a job alone",
                            meta: {
                                title: "Turn sandboxes into autonomous employees · intentic docs",
                                description:
                                    "Specialize a sandbox into an agent: its tools, systems and context. Give it work, make it event-driven, then scale to a team.",
                                datePublished: "2026-07-23",
                            },
                        },
                        {
                            id: "reference-architecture",
                            title: "Reference architecture",
                            blurb: "A whole company assembled from sandboxes",
                            meta: {
                                title: "Reference architecture · intentic docs",
                                description:
                                    "An entire company assembled from intentic sandboxes: one sandbox per role and team, connected to the services they share.",
                                datePublished: "2026-07-24",
                            },
                        },
                    ],
                },
            ],
        },
    ],
};

// What a consumer outside this module reads directly; placement, neighbours and page lookups go through book.ts with
// docsBook.
export const docsSections = docsBook.sections;
export const docsPages = bookPages(docsBook);
export const docsDestinations = bookDestinations(docsBook);

export function docsHref(id: string): string {
    return bookHref(docsBook, id);
}
