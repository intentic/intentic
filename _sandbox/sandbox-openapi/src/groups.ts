/* THE 37 GROUPS OF THE DAEMON'S SURFACE, IN READING ORDER, each with the one line that says what it is FOR,
 * and the shelf it sits on.
 *
 * This is the only hand-written content in the generated document, and it is hand-written because it is the
 * one thing the contract cannot state: a route declares its own shape, but nothing in `oc.route` knows that
 * `agent` is the group most readers arrive for and `providers` is plumbing almost nobody calls directly.
 *
 * ORDER IS EDITORIAL AND ALPHABETICAL ORDER IS NOT AN OPTION. A reader opening the reference wants the agent
 * surface, then the tree it works on, then the machinery around both. Alphabetised, `activity` (an audit feed)
 * opens the document and `agent` (the reason the API exists) is third.
 *
 * SHELVES ARE CONSECUTIVE RUNS OF THAT ORDER, never a second ordering laid over the first. The reference site
 * builds its rail from `SPEC_SHELVES`, and the generated document orders its paths by this list; if a shelf
 * could gather groups from anywhere, the rail and the document would present two different books with the same
 * contents. `groups.test.ts` fails a shelf whose groups are not contiguous, so the two orders are one order.
 *
 * COMPLETENESS IS GUARDED, NOT TRUSTED. The tests walk the contract and fail if a group here has no routes or
 * a group in the contract has no entry, so adding a contract file is a build error until it is described. That
 * is the repo's discovery-over-enumeration rule applied to the one enumerated list that has to exist: a list of
 * 37 prose paragraphs cannot be derived, but its AGREEMENT with the code can be.
 */

/** The shelves the reference rail is built from, in reading order. */
export interface SpecShelf {
    /** Stable id, used as the shelf's key wherever one is needed. */
    name: string;
    /** The rail heading and the nav row's label. */
    label: string;
    /** Who arrives at this shelf and what they want: rendered under the label and in the nav menu. */
    audience: string;
}

export const SPEC_SHELVES: readonly SpecShelf[] = [
    {
        name: "agents",
        label: "Agents",
        audience: "Say something to an agent, watch it work, and decide what happens to what it wrote.",
    },
    {
        name: "workspace",
        label: "The workspace",
        audience: "The files and repos the agents work on, and the history of both.",
    },
    {
        name: "kit",
        label: "What an agent carries",
        audience: "The instructions, characters and add-ons that decide how an agent behaves.",
    },
    {
        name: "connections",
        label: "Connected systems",
        audience: "The outside world: accounts, credentials, tunnels and the infrastructure you declared.",
    },
    {
        name: "models",
        label: "Models and accounts",
        audience: "Which models are available, whose subscription pays for them, and what has been spent.",
    },
    {
        name: "ship",
        label: "Ship and share",
        audience: "Checks before code leaves the machine, and the ways work reaches other people.",
    },
    {
        name: "daemon",
        label: "The sandbox itself",
        audience: "The daemon's own identity, its live event stream, and the record it keeps.",
    },
];

export interface SpecGroup {
    /** The contract's own key, which is also the tag name and the first segment of the group's routes. */
    name: string;
    /** The shelf this group sits on: a `SpecShelf.name`. */
    shelf: string;
    /** The tag's display name: what the sidebar and the page heading show. */
    label: string;
    /** One sentence, present tense, no trailing period: what this group is for. */
    summary: string;
    /** The longer form, shown at the head of the group's page. Free to run to a short paragraph. */
    description: string;
}

export const SPEC_GROUPS: readonly SpecGroup[] = [
    // ── Agents ────────────────────────────────────────────────────────────────────────────────────────
    {
        name: "agent",
        shelf: "agents",
        label: "One agent",
        summary: "Run a turn in one conversation, then attach to it, answer it, steer it or stop it",
        description:
            "The surface most callers are here for. Starting a turn answers with a run id and nothing else: the work happens inside the sandbox whether or not anybody stays connected, and attaching is how you watch it, from the beginning or from wherever you had got to. The rest is the things a person does to a turn in flight — answer a question it asked, redirect it, stop it, or put the whole conversation back to an earlier point. Everything here addresses one conversation by id.",
    },
    {
        name: "agents",
        shelf: "agents",
        label: "The fleet",
        summary: "Every registered conversation, its accumulated diff, and landing or discarding its work",
        description:
            "The roster rather than the turn. Each conversation works in its own private copy of the repos, so it has a cumulative set of changes you can read and two ways for it to end: merge that work into the shared tree, or throw it away. The rest is the bookkeeping a board needs — renaming, marking read, archiving, purging.",
    },
    {
        name: "sessions",
        shelf: "agents",
        label: "Past sessions",
        summary: "Conversations that have finished, and their transcripts",
        description: "Two reads. The list of past conversations, and one conversation's full record by id.",
    },
    {
        name: "workflows",
        shelf: "agents",
        label: "Workflows",
        summary: "Several agents in a fixed order, the designs and the runs",
        description:
            "A workflow is a design: run these conversations, in this order, each handing its result to the next. These routes hold the saved designs and the run history, start a run, stop one in flight, and archive the ones you are done reading.",
    },
    {
        name: "loops",
        shelf: "agents",
        label: "Loops",
        summary: "One conversation run again until it gets there, and the saved designs behind them",
        description:
            "A loop repeats a conversation towards a goal until it converges or gives up. One half is what is running right now; the other is the designs somebody authored once and can point at a different job each time.",
    },
    {
        name: "automations",
        shelf: "agents",
        label: "Automations",
        summary: "Work the sandbox starts on its own, and the approvals it parks waiting for you",
        description:
            "Scheduled and triggered work: what can trigger one here, what is configured, and switching one on or off, deleting it or firing it by hand. The other half is the approval queue — an automation set to ask first lands there each time it would have run.",
    },

    // ── The workspace ─────────────────────────────────────────────────────────────────────────────────
    {
        name: "workspace",
        shelf: "workspace",
        label: "Workspace",
        summary: "The file tree the agents work on: read it, search it, change it, and run what is in it",
        description:
            "Everything under the workspace root. The tree and one folder's contents, a window of a file's text, search that blends text, structure, meaning and history, and the ordinary changes: make a folder, delete, move, copy. It also holds what a workspace knows about itself — which repos it contains, how its packages depend on each other, which apps are in it, and starting or stopping one.",
    },
    {
        name: "git",
        shelf: "workspace",
        label: "Git",
        summary: "Version control, one repository at a time",
        description:
            "The largest group here, and the shape is consistent: the repo rides in the address and the verb is the route. Reading is history, differences and status; writing is staging, committing, branching, tagging, stashing, cherry-picking, reverting and pushing. Two routes cover a repo caught mid-merge or mid-rebase, and one answers what undoing would actually do before you undo it.",
    },
    {
        name: "history",
        shelf: "workspace",
        label: "History",
        summary: "Saved states of the whole workspace, and putting one back",
        description:
            "The points the sandbox saves as work happens, what changed between one and the next, one file's two sides, and restoring from one.",
    },
    {
        name: "chores",
        shelf: "workspace",
        label: "Chores",
        summary: "What every repository currently measures, and what has been done about it",
        description:
            'Maintenance evidence: read the measurements, ask for one to be retaken, record what somebody concluded. There is deliberately no "run this chore" route, because a chore run is an ordinary conversation and so already has its own working copy, record and cost.',
    },
    {
        name: "panels",
        shelf: "workspace",
        label: "Panels",
        summary: "Each repository's dev server: what it is and whether it is running",
        description:
            "One entry per repo, with whether its preview server is up and what the app worked out about its contents. Starting and stopping are here; watching the output is the terminal's job.",
    },
    {
        name: "ports",
        shelf: "workspace",
        label: "Ports",
        summary: "What is listening inside the sandbox, and forwarding one out",
        description: "The ports something is answering on, and giving one an address on the outside or taking that away.",
    },

    // ── What an agent carries ─────────────────────────────────────────────────────────────────────────
    {
        name: "personas",
        shelf: "kit",
        label: "Personas",
        summary: "Named characters an agent can wear: the accounts it speaks for and what it is told",
        description:
            "A persona records a decision about accounts that already exist: which of them this character speaks for, what a conversation wearing it may do, and what it is told. The kit routes edit the files behind one — its own instructions, and the skills only its conversations reach.",
    },
    {
        name: "skills",
        shelf: "kit",
        label: "Skills",
        summary: "The instruction packs an agent can be handed",
        description:
            "What is available and whether each is on, the text of one, and writing or deleting one. The list joins four separate sources into a single answer.",
    },
    {
        name: "extensions",
        shelf: "kit",
        label: "Extensions",
        summary: "Installed extensions: their settings, their readiness, their updates and their processes",
        description:
            "The runtime half of the extension format documented under Developers. These routes enumerate what is installed, read and write each one's settings, switch it on or off, check for updates and apply or undo one, and start or stop the long-running processes an extension declares.",
    },
    {
        name: "settings",
        shelf: "kit",
        label: "Settings",
        summary: "The sandbox's own configuration, plus what it has saved you and which rules fired",
        description:
            "Read and write the settings that govern how agents behave here. The other three routes are read-only reports on their effects: what the token-saving measures were actually worth, the text behind a built-in prompt, and when each rule last did something.",
    },

    // ── Connected systems ─────────────────────────────────────────────────────────────────────────────
    {
        name: "capabilities",
        shelf: "connections",
        label: "Capabilities",
        summary: "The outside systems this sandbox is wired into, and connecting a new one",
        description:
            "A capability is a system the agent can reach: a forge account, a chat server, a database, one of your own machines. These routes connect and disconnect them, carry the credential each needs, report whether a connection is live, and drive the interactive parts of a sign-in, including a one-time code.",
    },
    {
        name: "secrets",
        shelf: "connections",
        label: "Secrets",
        summary: "Stored values the agent can use without ever reading them",
        description:
            "Write a secret, list which names exist, delete one. Revealing a value is the deliberate exception and the only route that hands one back; everywhere else the daemon substitutes a secret by reference at the moment a command runs.",
    },
    {
        name: "vpn",
        shelf: "connections",
        label: "VPN",
        summary: "Corporate tunnels the sandbox can hold open",
        description:
            "What is configured, dialling and dropping one, and reading connections out of an exported client configuration. Link state is read back from the operating system, not from memory.",
    },
    {
        name: "exit",
        shelf: "connections",
        label: "Exit locations",
        summary: "Sending the sandbox's outbound traffic out of a chosen country",
        description:
            "Which countries a provider offers, bringing an exit up, moving it, taking a fresh address in the same country, and checking where the world actually sees you. That last check is what the others are judged against: a switch that quietly left traffic where it was is the failure this exists to rule out.",
    },
    {
        name: "inventory",
        shelf: "connections",
        label: "Inventory",
        summary: "What this sandbox has and what it wants, as declared deployment intent",
        description:
            "The entries in the workspace's deployment configuration. Adding or removing one rewrites that file and commits it, exactly as an agent editing it by hand would, and answers with the whole updated list so a caller redraws from one response.",
    },
    {
        name: "intentic",
        shelf: "connections",
        label: "Platform CLI",
        summary: "Run the in-sandbox platform tool and follow its output as it arrives",
        description:
            "Runs the sandbox's own command-line tool and streams its output line by line. The reconcile is separated out because it takes minutes: it starts a background job and answers at once, and its event stream replays from the beginning and then follows live, so a page refresh does not lose the progress.",
    },

    // ── Models and accounts ───────────────────────────────────────────────────────────────────────────
    {
        name: "claude",
        shelf: "models",
        label: "Claude accounts",
        summary: "Connecting an Anthropic subscription, and the accounts already connected",
        description:
            "Begin and finish a sign-in, list what is connected with how full each account's limits were, rename one, disconnect one. A sandbox can hold several side by side.",
    },
    {
        name: "grok",
        shelf: "models",
        label: "Grok accounts",
        summary: "Connecting an xAI subscription, and the account already connected",
        description:
            "Begin a sign-in with a code typed on another page, see what is connected, disconnect it. The sandbox waits for the sign-in to complete on its own, so nothing is pasted back.",
    },
    {
        name: "translator",
        shelf: "models",
        label: "Routed providers",
        summary: "Subscriptions that run another vendor's model under the Claude Code harness",
        description:
            "The bundled translator runs a non-Claude model on the user's own subscription, so each provider connects by signing in rather than with an API key, and one provider can hold several accounts at once. Two sign-in shapes ride these routes: a code typed on a device page, which finishes by itself, and a redirect whose landing address is handed back.",
    },
    {
        name: "endpoints",
        shelf: "models",
        label: "Endpoints",
        summary: "A model server you configured, and the free trial's allowance",
        description:
            "Every built-in provider's catalogue is one fixed route, because there is one of each. Endpoints are user-created and unbounded, so the id rides in the address and the answer is whatever the configured server says about itself. The trial belongs here because the trial is an endpoint — the one the daemon provisions rather than you.",
    },
    {
        name: "providers",
        shelf: "models",
        label: "Providers",
        summary: "A built-in provider's model catalogue",
        description:
            "One read, for the providers the sandbox ships with. Never empty, and left in the provider's own preference order rather than rearranged.",
    },
    {
        name: "usage",
        shelf: "models",
        label: "Usage",
        summary: "What has been spent, grouped",
        description:
            "One read: the spending record over a range of days, grouped finely enough that every cost screen is a rearrangement of it rather than a second call.",
    },

    // ── Ship and share ────────────────────────────────────────────────────────────────────────────────
    {
        name: "ci",
        shelf: "ship",
        label: "Pipelines",
        summary: "Continuous integration runs, and asking an agent to fix a red one",
        description:
            "Read the runs and the jobs inside them, re-run or cancel one, and mark the board read. The interesting one hands a failing run to an agent rather than to you.",
    },
    {
        name: "prepush",
        shelf: "ship",
        label: "Pre-push check",
        summary: "The suite that runs before anything leaves the machine",
        description:
            "Three verbs about one run, because there is one main working tree and so exactly one check. Starting it answers immediately: a suite takes minutes, and a request held open that long dies at the first proxy. Poll for the verdict; the answer names the terminal where it is really happening.",
    },
    {
        name: "public",
        shelf: "ship",
        label: "Outbox",
        summary: "Files published to a public address, with no sign-in",
        description:
            'What the outbox holds and its address. Publishing copies a workspace file or folder in; withdrawing the last one removes the outbox, so its existing always means exactly "something is published". There is no route to read a published file back, because that is what the open address is for.',
    },
    {
        name: "share",
        shelf: "ship",
        label: "Sharing",
        summary: "Conversations published as read-only pages",
        description:
            "What is currently shared, publishing a conversation, re-rendering one from how it stands now, and taking it down. As with the outbox, the page itself is the read.",
    },
    {
        name: "drafts",
        shelf: "ship",
        label: "Post drafts",
        summary: "Posts the agent has proposed, waiting for you to approve them",
        description:
            "The owner's side of the queue. The agent writes drafts directly; this is the inbox, the one call that covers approving, editing and retrying, and the deletion that is a rejection.",
    },

    // ── The sandbox itself ────────────────────────────────────────────────────────────────────────────
    {
        name: "system",
        shelf: "daemon",
        label: "System",
        summary: "The daemon itself: its identity, its event stream, its terminals, its browsers, its helpers",
        description:
            "The group with the widest job. The identity read is what the daemon says it is, including the routes it implements, which is the one call that tells a newer client what this sandbox can do. The event stream is the sandbox-wide live feed. The rest is the machinery an agent leaves running: terminals and their history, browsers, and the records of helpers it delegated to.",
    },
    {
        name: "activity",
        shelf: "daemon",
        label: "Activity",
        summary: "The audit feed of what the agent did out in the world",
        description:
            "Read-only by design. Entries are written by the sandbox alone and never by a caller, which is the whole reason the record can be trusted.",
    },
    {
        name: "logs",
        shelf: "daemon",
        label: "Logs",
        summary: "The sandbox's durable debug record",
        description: "What log files exist, and a window of one. Captured terminal output, command runs, and the daemon's own log.",
    },
    {
        name: "push",
        shelf: "daemon",
        label: "Push notifications",
        summary: "So a finished turn can reach you when the tab is closed",
        description:
            "What a device needs in order to subscribe, subscribing and unsubscribing, and a test. The test earns its place because there are four separate places a notification can be lost that nobody can inspect from outside.",
    },
];

/** Tag objects for the OpenAPI document, in the editorial order above. */
export const specTags = (): { name: string; description: string }[] =>
    SPEC_GROUPS.map((group) => ({
        name: group.label,
        description: group.description,
    }));

const byName = new Map(SPEC_GROUPS.map((group) => [group.name, group]));

/** The group a contract key belongs to, or undefined when the contract has grown one nobody has described. */
export const specGroup = (name: string): SpecGroup | undefined => byName.get(name);

/** Each shelf paired with its groups, in reading order: what the reference rail is built from. */
export const specShelves = (): { shelf: SpecShelf; groups: SpecGroup[] }[] =>
    SPEC_SHELVES.map((shelf) => ({ shelf, groups: SPEC_GROUPS.filter((group) => group.shelf === shelf.name) }));
