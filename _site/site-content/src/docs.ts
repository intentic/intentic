import { type Book, bookDestinations, bookHref, bookPages } from "./book";

/* /docs: written for somebody USING intentic. The authoring book is api.ts, and the line between them is the
 * reader: a person installing an extension is doing an ordinary product task, a person writing one is not.
 *
 * SHELVED BY WHO IS READING, not by lifecycle stage. Sorting by stage ("Get started", "Guides", "Extend",
 * "API reference") put installing, understanding and maintaining on one shelf while a second swallowed half the
 * documentation in a flat list. Four questions actually bring people here, and they are questions about the
 * READER: I want to know what this is; I run the machine this thing lives on; I want to wire my own systems into
 * it; I do the day's work in it.
 *
 * WHY AN "INTEGRATIONS" SHELF. Three pages were answering one question: how does an outside thing get into this
 * sandbox?: from two different shelves. A connector, somebody else's extension and your own laptop are the same
 * decision made about three kinds of outsider, and a reader who has just wired up GitHub is the reader most
 * likely to want the other two.
 *
 * NO RUN EXCEEDS FIVE ROWS. A shelf a reader has to parse rather than scan is a wall at a different address, so
 * the one long shelf carries a sub-heading. */
export const docsBook: Book = {
    id: "docs",
    label: "Docs",
    sections: [
        {
            label: "Understand",
            audience: "What this is, before you install anything.",
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
                                    "How intentic gives each coding agent its own sandbox, a specialized workspace on hardware you own, and where to start in the docs.",
                                datePublished: "2026-07-23",
                            },
                        },
                        {
                            id: "architecture",
                            title: "Architecture",
                            blurb: "The thin platform, your sandbox, the tunnel between",
                            meta: {
                                title: "Architecture · intentic docs",
                                description:
                                    "How intentic fits together: the thin platform, the per-agent sandbox on your hardware, the ownership model, and the tunnel fabric.",
                                datePublished: "2026-07-23",
                            },
                        },
                        {
                            /* ON THE FIRST SHELF, because the words are load-bearing from the second page onwards.
                             * "daemon" appeared 92 times across 14 pages and was defined nowhere; "land", "worktree"
                             * and "harness" were each first used a shelf before the page that explains them, and
                             * searching for "glossary" returned nothing at all. */
                            id: "glossary",
                            title: "Glossary",
                            blurb: "Every word these docs use as if you knew it",
                            meta: {
                                title: "Glossary · intentic docs",
                                description:
                                    "What intentic means by daemon, sandbox, workspace, conversation, worktree, landing, fleet, harness, capability, slug, overlay, control token, chore and guard.",
                                datePublished: "2026-08-11",
                            },
                        },
                    ],
                },
            ],
        },
        {
            label: "Run a sandbox",
            audience: "You own the machine: install it, keep it, share it.",
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
                            /* Retitled from "Updates & what never breaks". The old title was the page's ARGUMENT,
                             * which is the right thing for a <title> and the wrong thing for a sidebar row: at the
                             * rail's width it wrapped to two lines and pushed every row below it out of rhythm. The
                             * promise it makes is still the meta description, where the reader deciding whether to
                             * click actually reads it. */
                            id: "updates",
                            title: "Updates & rollback",
                            blurb: "The promises every update keeps, and the way back",
                            meta: {
                                title: "Updates: what we promise never breaks · intentic docs",
                                description:
                                    "What an intentic update can never touch: your files survive every update and rollback, updates are offered rather than forced, breaking changes are flagged before you take them, and a release reaches you as soon as it passes.",
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
                            /* LAST ON THE SHELF THAT OWNS THE MACHINE, because that is where the failures are: Docker, a
                             * tunnel, and somebody else's credentials. The docs had no such page at all: "troubleshoot"
                             * and "not working" both returned nothing, and the agent-side symptoms on it are here
                             * rather than on a second page because a reader who cannot tell which half broke is exactly
                             * the reader who needs it. */
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
            audience: "Outside systems, extensions and your own computer, wired into a sandbox.",
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
                            /* THE INSTALLER'S HALF of the extension lifecycle, and a page that did not exist: browsing,
                             * approving, updating and switching one off were written inside the page for AUTHORS, so
                             * the reader doing the most common thing anyone does with an extension had to read a
                             * publishing guide to find out what the install dialog was telling them. Building one is
                             * the other half, and it lives in /developers. */
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
                            blurb: "Desktop sync, connected computers, the editor bridge",
                            meta: {
                                title: "Your own machine · intentic docs",
                                description:
                                    "Sync a folder into the sandbox, let the agent operate your computer, or drive its agents from Zed or JetBrains over ACP.",
                                datePublished: "2026-08-07",
                            },
                        },
                    ],
                },
            ],
        },
        {
            label: "Drive agents",
            audience: "The everyday work, and whole things built out of it.",
            entry: "parallel-agents",
            groups: [
                {
                    items: [
                        {
                            id: "parallel-agents",
                            title: "Parallel agents",
                            blurb: "Many agents at once, reviewed before anything lands",
                            meta: {
                                title: "Parallel agents · intentic docs",
                                description:
                                    "Run several agents at once, each in its own checkout of your repos, and review what they did before any of it reaches the tree you work in.",
                                datePublished: "2026-08-07",
                            },
                        },
                        {
                            id: "automations",
                            /* NAMES ALL THREE, though it is the longest row in the rail. "Automations & workflows"
                             * never said "loops", so a reader after "run this until it's green" had no reason to open
                             * the one page that answers them, and loops are a third of it. It still sets on one line
                             * at the rail's width; "Updates: what we promise never breaks" below is the length that
                             * does not. */
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
                    /* The three pages that are not "how does this surface work" but "here is a whole thing someone
                     * built out of the ones above". They read as a payoff and they were the reason the old Guides
                     * shelf felt shapeless: a reader looking for how capabilities work had to step over an entire
                     * company blueprint to reach it. */
                    label: "Worked examples",
                    items: [
                        {
                            id: "doorbell",
                            title: "Doorbell",
                            blurb: "Put a chat on your website, answered by your agent",
                            meta: {
                                title: "Doorbell · put your agent on your website · intentic docs",
                                description:
                                    "Embed a chat widget on your site with one script tag. Visitors talk to your sandbox agent; you watch and take over from the fleet board.",
                                datePublished: "2026-08-01",
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
                                    "An entire company assembled from intentic sandboxes: one agent per role and team, connected to the services they share.",
                                datePublished: "2026-07-24",
                            },
                        },
                    ],
                },
            ],
        },
    ],
};

/* Only what a consumer outside this module actually reads. Everything ELSE a page needs, such as the placement
 * of an id, its neighbours and the page itself, is asked of `book.ts` with `docsBook` in hand because the layout takes
 * the book as a prop and cannot know which of two per-book helper sets to call. */
export const docsSections = docsBook.sections;
export const docsPages = bookPages(docsBook);
export const docsDestinations = bookDestinations(docsBook);

export function docsHref(id: string): string {
    return bookHref(docsBook, id);
}
