import type { sandboxContract } from "@intentic/sandbox-contract";
import type { ContractRouterClient } from "@orpc/contract";
import type { Component } from "vue";
import type { DiffPayload } from "./diff.js";
import type { CapabilityFacts, RepoFacts } from "./facts.js";

/* The host API an extension programs against. There is no ambient global: the implementation arrives as the
 * `activate(api, context)` argument, and everything an extension registers is returned as a Disposable pushed
 * onto context.subscriptions so deactivation can unwind it. */

export interface Disposable {
    dispose(): void;
}

// One sidebar element a view contributes: routed at /ext/<viewId>/<key> (the key segment is dropped when it
// equals the view id, a singleton view links to /ext/<viewId>), rendered by the view's component with
// `repo` (+ props) bound.
export interface Activation {
    // Stable per-view key (usually the repo name), the route segment, so deep links survive reloads.
    readonly key: string;
    readonly title: string;
    // An icon name from the host's icon set; absent ⇒ the rail renders the title's initials.
    readonly icon?: string | undefined;
    // The repo this element is rooted at, the fallback-dedup subject and the component's `repo` prop. Absent
    // for capability-driven elements, which aren't rooted at any repo.
    readonly repo?: string | undefined;
    readonly props?: Record<string, unknown> | undefined;
}

// What a sidebar element may say on its own tile without being opened. The rail is glanced at, not read, so
// this is deliberately the smallest useful vocabulary: a number and how alarmed to be about it.
//
// A badge is a claim on the user's attention, so the bar is the same one the core surfaces already hold
// themselves to: it must mean "something happened here that you don't already know about", never "here is a
// statistic". A count that is lit most of the day teaches the user to stop seeing the rail.
export interface ViewBadge {
    // How many, for work whose SIZE is what the user acts on, two files to review and two hundred are
    // different afternoons. Omitted or 0 ⇒ no number. The host renders anything above 99 as "99+".
    readonly count?: number | undefined;
    // A glyph from the host's icon set, rendered INSTEAD of a number, for a pending action whose size changes
    // nothing about what the user does with it: one click either way. "There is committed work here waiting to
    // be sent" is the whole message, and a number beside it would be read in the unit `count` established,
    // so the amount goes in the tooltip and the glyph carries the kind. A badge with neither renders nothing.
    readonly mark?: string | undefined;
    // THE FIRST QUESTION A BADGE ANSWERS IS "DO I OWE THIS ANYTHING?", and until `neutral` existed there was no
    // way to say no. A count that means "three things are alive in here" (open browsers, running services) was
    // drawn exactly like one that means "three things are waiting on you", same pill, same tint, same digit,
    // so a reader who chased one and found an inventory learned that badges do not repay being chased. That is
    // the failure this vocabulary exists to prevent, arriving through the door it left open.
    //
    // `neutral` is an INVENTORY: true most of the day, nothing owed, quiet ink. `info` is the resting tone for
    // work the user can act on (unread agents, uncommitted changes); `warning` marks a risk they are carrying
    // (an exposed port); `danger` means something is BROKEN, reach for it sparingly, its whole value is that it
    // is rare enough to still mean something. Absent still means `info`, so a badge that says nothing about its
    // tone is still assumed to be asking for something.
    readonly tone?: "neutral" | "info" | "warning" | "danger" | undefined;
    // Say what happened and how much, not just the number the user can already see. The host renders it
    // AFTER the view's own name, "Agents · 3 need you" on the rail, the chip's text in the mobile menu, so
    // phrase it as the continuation of a label, not as a standalone sentence that repeats the view.
    readonly tooltip?: string | undefined;
}

/* ONE CACHED READ, described rather than performed, the currency both `ViewRegistration.warm` and
 * `api.sandbox.fetch` deal in.
 *
 * It is deliberately the shape a vue-query `useQuery` already takes, because that is the point: the entry a
 * view warms, the entry its badge fills from a timer and the entry the view's own `useQuery` observes are ONE
 * entry, and they are one entry because all three name it the same way. Two of the three used to be separate
 * reads of the same route in this app's own extensions, the tile fetched the report every ten minutes and kept
 * it privately, and the view it badged for started from nothing every time it was opened.
 *
 * The caching terms are optional and yours: `staleTime` is how long an answer stays believable without a
 * refetch (Infinity for something only an invalidation can make wrong), `gcTime` how long it survives with
 * nothing observing it. Both default to the host's. */
export interface HostQuery<T = unknown> {
    // MUST be scoped by api.sandbox.key(...), so nothing bleeds across a sandbox switch.
    readonly queryKey: readonly unknown[];
    readonly queryFn: () => Promise<T>;
    readonly staleTime?: number | undefined;
    readonly gcTime?: number | undefined;
}

// A view's runtime registration, for third-party extensions, `id`, `label` and `surface` must match a
// `contributes.views` entry in the approved manifest or the host refuses the registration.
export interface ViewRegistration {
    readonly id: string;
    // The view family's human name (distinct from an Activation's per-repo `title`), labels the directory
    // panel's surface switch when a repo activates several.
    readonly label: string;
    // Where the view's activations mount. `rail` is the always-visible left column, a place the user ACTS
    // from, so a tile there must earn a permanently occupied slot. `directory` is a per-repo panel opened from
    // the Workspace tree. `sandbox` is a tab on the Sandbox hub, where the subject is the box itself (its
    // logs, its status, its consumption), inspected occasionally rather than worked in, so it costs a tab in
    // a scrolling word-labelled strip instead of an icon in the rail's fixed budget.
    readonly surface: "rail" | "directory" | "sandbox";
    /* Evidence-based detection over the public facts, one activation per sidebar element. Called on every
     * facts poll; a throwing detect contributes nothing that round.
     *
     * MUST NOT WRITE REACTIVE STATE. This runs inside the host's render computed, so a `sandboxRef` (or any
     * other `Ref`) written here is a computed mutating its own dependency: Vue re-runs it, it writes again,
     * and the rail recurses until the frame is abandoned, taking every unrelated update queued behind it, so
     * the symptom is a window that stops responding rather than one misbehaving tile.
     *
     * It IS the right place to notice things, though, it is the only callback that sees the live facts, so
     * for the bookkeeping that notice produces (which connections a poller should ask about next round) use
     * `sandboxValue`, which has the same lifetime and no observers. Same rule for `badge` below. */
    readonly detect: (repos: readonly RepoFacts[], capabilities: readonly CapabilityFacts[]) => Activation[];
    // What this activation's tile should say without being opened. Read inside the host's own computed, so
    // reading a ref here re-renders the tile when it changes, no push channel needed. Called on every render
    // of every surface that draws tiles, so it must be cheap and pure: derive from state the extension already
    // keeps, never fetch, and never write a ref (see detect above, same computed, same recursion). A throwing
    // badge simply yields none.
    //
    // Requires `badge: true` on the manifest's matching contributes.views entry, the host drops the function
    // otherwise, because a tile that can interrupt the user is a contribution the owner must have approved.
    // The source has to stay alive while the view is UNMOUNTED (a badge you only see once you have already
    // navigated to the view is pointless), so it belongs in module state owned by activate(), not in the view.
    readonly badge?: ((activation: Activation) => ViewBadge | undefined) | undefined;
    /* WHAT THIS VIEW WOULD LIKE IN HAND BEFORE ANYONE OPENS IT, read ahead by the host's background loader in
     * the gaps between what the user is already doing, so the tile opens with content instead of a skeleton.
     *
     * A rail tile is at the far end of the loader's priority order (the user is not there, they might GO
     * there), so this is a wish and never a guarantee: on a workspace busy enough that nothing is spare, none
     * of it is read and the view costs exactly what it cost before. Nothing here is user-visible, nothing
     * retries, and a failed warm is simply a warm that did not happen.
     *
     * DECLARE THE QUERY, not a function that fetches it, that is the whole reason this takes a HostQuery. The
     * host's own wishes used to carry a cache key and a separate "how to read it" callback, and for most of
     * them the callback fetched the data and returned it to its caller without ever filing it under that key.
     * The wish could then never be satisfied, and since the loader always takes the first unsatisfied wish, one
     * of them was enough to park it for the whole session. Handing over the query makes the two halves the same
     * object. Use the SAME key your view's `useQuery` reads (api.sandbox.key(...)), or you are warming an entry
     * nothing will look in.
     *
     * Called on every beat of the loader, so it must be cheap and pure, derive from state you already keep,
     * never fetch. A throwing warm contributes nothing that beat. */
    readonly warm?: (() => readonly HostQuery[]) | undefined;
    // A fallback view's activations are dropped for repos already claimed by a non-fallback one.
    readonly fallback?: true | undefined;
    // An AUXILIARY view adds a surface BESIDE whatever else serves the repo instead of replacing it, a test
    // runner, a docs browser. Its activations render and mark the directory manageable exactly like any other,
    // but they do not claim the repo, so the fallback view (the raw dev-server preview) survives alongside.
    // Claiming is for a view that subsumes the fallback: `apps` renders the preview URLs itself, so dropping
    // the preview tile beside it is right; a test runner renders no preview, so dropping it would be a loss.
    readonly auxiliary?: true | undefined;
    // Lazily imported root component, rendered with `repo` (+ props) bound.
    readonly view: () => Promise<Component>;
}

// A custom file viewer's runtime registration, `id` must match a `contributes.viewers` entry in the approved
// manifest (the host reads the file extensions + fetch kind from there). The host resolves an open file to this
// viewer, gets its content, and renders `component` with `{ path, text?, blob?, src? }` bound, which of the
// three content props is filled is decided by the manifest's `fetch` (see ViewerContributionSchema).
export interface ViewerRegistration {
    readonly id: string;
    readonly component: () => Promise<Component>;
}

// What a directory row offers when a provider has a document for it: the icon the Workspace tree draws on that
// row, and what the tab it opens is called. `icon` is an open string like Activation.icon, a name outside the
// host's set renders nothing rather than failing the registration.
export interface DocumentOffer {
    readonly icon: string;
    // Names the ACTION on the row ("Open architecture doc"), since that is what a tooltip on an icon is read as.
    readonly tooltip: string;
    // The tab's label. Short: the strip already shows the directory's own name beside it.
    readonly title: string;
    /* Whether the row keeps this icon when the pointer is elsewhere. A tree row's icons are revealed on hover,
     * because a permanent column of them is what stops the eye reading names, but that rule assumes an icon is
     * an ACTION you already know you want. An offer that is EVIDENCE is the opposite case: "there is a page about
     * this package" is a fact nobody can act on until they see it, and finding it by sweeping fifty-five rows with
     * the mouse is not finding it. Such an offer sets this, and the row carries it dimmed until hover.
     *
     * Left off (the default) by an offer every directory of its kind gets, a repo's git history is always there,
     * so a permanent glyph states nothing and costs the same attention. */
    readonly evidence?: boolean;
}

/* A DOCUMENT PROVIDER, an extension's answer to "there is something to READ about this directory".
 *
 * PATH-KEYED, which is the whole reason it is not a `view`. `detect()` on a ViewRegistration answers per REPO
 * off the daemon's facts, and that is the wrong grain for a document: a monorepo is one repo with fifty-five
 * documented packages. So this asks per directory instead, and the Workspace tree, not the rail, not a routed
 * area, is where the answer lands.
 *
 * The host owns the tab. A provider says "yes, and here is what to call it"; opening it mounts `view` with the
 * path bound, in the editor area beside the files it describes. That placement is the point: documentation about
 * a package belongs next to the package, not behind a navigation away from it. */
export interface DocumentProviderRegistration {
    // Must match a `contributes.documents` entry in the approved manifest.
    readonly id: string;
    /* Whether this provider has a document for a workspace path (root-relative; "" is the workspace root), and
     * what the row should offer if so. Called for every visible directory row on every render of the tree, so it
     * must be a LOOKUP and never a fetch, derive it from state the extension already keeps. Reading a ref in
     * here is what repaints the tree when documents land, the same contract (and the same reason) as
     * ViewRegistration.badge; and like badge, that state has to outlive the view being unmounted, so it belongs
     * in module state owned by activate(). A throwing detect simply offers nothing for that row. */
    readonly detect: (path: string) => DocumentOffer | undefined;
    // Lazily imported component, rendered with `path` bound.
    readonly view: () => Promise<Component>;
}

/* EVERYTHING THAT DECIDES WHO SERVES A TURN, as one value. The label is here because a view that shows a chosen
 * model without showing the list would otherwise have to keep a catalog of its own, which is exactly the
 * duplication `api.models` exists to end.
 *
 * The last two are optional because they are pins, and the unpinned state is the one most callers want: absent
 * means "whatever the daemon resolves", which is what keeps a saved choice working after an account is
 * disconnected or a harness gains a provider. A caller that only cares which model runs can ignore both and
 * lose nothing. */
export interface PickedModel {
    // An `AgentProvider`, `claude`, `codex`, a configured model endpoint's id, an installed ACP agent's id.
    // Open on purpose: the set grows with what the sandbox has connected, and an extension only carries it.
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    /* WHICH CONNECTED ACCOUNT of that provider runs the turn, by its daemon-minted id, absent ⇒ whichever comes
     * first. It is on the pick rather than left to the daemon because the surfaces that start UNATTENDED runs are
     * the ones that need it: nobody is watching at 6am, so a first account that has run out of headroom (or whose
     * organization switched the plan off) is a run that errors every time until someone reads the row. */
    readonly account?: string | undefined;
    /* What the shell calls that account, the sign-in identity, which is the only part of it the owner
     * recognises ("Claude" is what three unrenamed accounts are all called).
     *
     * Absent means the shell cannot name it, which covers BOTH a pin whose credential has been disconnected and
     * an account list this sandbox has not been read for yet. Do not render the first from the second: they are
     * the same absence, and a view that reads it as "this automation is broken" says so about every row while the
     * daemon is merely still starting. Show the name when there is one, and nothing when there isn't. */
    readonly accountLabel?: string | undefined;
    // `native` or `claude-code`, the agentic loop, an axis of its own since codex/grok run the same subscription
    // model ids under either. Absent ⇒ native, which for every other provider is the only answer there is.
    readonly harness?: string | undefined;
}

export type SettingValue = string | number | boolean;

export interface ProcessStatus {
    readonly name: string;
    readonly running: boolean;
    readonly port?: number | undefined;
    readonly previewUrl?: string | undefined;
}

export interface IntenticApi {
    // The host's @intentic/extension-api version, what `engines.intentic` was checked against.
    readonly apiVersion: string;
    readonly views: {
        register(view: ViewRegistration): Disposable;
    };
    // Custom file viewers (contributes.viewers), the host owns the fetch + open-file lifecycle and renders the
    // registered component with the file's content; the extension only renders. See ViewerRegistration.
    readonly viewers: {
        register(viewer: ViewerRegistration): Disposable;
    };
    // Per-directory documents (contributes.documents), the extension says which directories it can explain and
    // renders one; the host draws the tree's affordance and owns the tab. See DocumentProviderRegistration.
    readonly documents: {
        register(provider: DocumentProviderRegistration): Disposable;
        /* Open one of THIS extension's documents for a directory, as if its row icon had been clicked.
         *
         * The row is the ordinary way in, so this is for the directories that have no row: the workspace root,
         * which the tree renders the contents of rather than a line for. Without it a command contributed
         * alongside a document provider, "Show Git History" in the palette, has nothing it can actually open.
         *
         * `id` must be one of this extension's registered providers, and the provider must have an offer for
         * `path` (the same `detect()` the tree asks); a provider that has nothing to say about the directory
         * opens nothing rather than an empty tab. The title and glyph come from that offer, so the tab reads
         * exactly as it would have from the row. */
        open(id: string, path: string): void;
    };
    readonly commands: {
        // `command` must match a `contributes.commands` entry in the approved manifest.
        register(command: string, handler: (...args: unknown[]) => unknown): Disposable;
        execute(command: string, ...args: unknown[]): Promise<unknown>;
    };
    // The extension's own declared settings, persisted daemon-side and shared across the owner's browsers.
    readonly settings: {
        get(key: string): SettingValue | undefined;
        set(key: string, value: SettingValue): Promise<void>;
        onDidChange(listener: (key: string) => void): Disposable;
    };
    // The authenticated transport to the sandbox daemon's routes, auth is injected host-side; an extension
    // never sees tokens. Reach is scoped: every door here is gated by the manifest's `permissions.sandbox`
    // allowlist, so a call to an undeclared method+path throws rather than reaching the whole daemon.
    readonly sandbox: {
        /* THE DAEMON, TYPED, the same contract the daemon implements, so a call names a procedure instead of
         * building a URL. `rpc.git.stashApply({ repo, ref, pop })` carries the declared input shape and answers
         * the declared output shape, both checked at build time.
         *
         * This is the door to reach for. `request`/`json` below take a path string, which means every caller
         * re-derives what this already knows: the method, the escaping, the query encoding, and the shape of the
         * answer, the last of those as an unchecked assertion that keeps compiling long after the daemon's reply
         * has changed underneath it. Thirteen extensions between them hand-wrote a hundred such calls and
         * re-validated half the responses against the very schemas the contract had already declared.
         *
         * Gated identically, and on the same evidence: the host resolves the procedure to its method and concrete
         * path and checks THAT against `permissions.sandbox`, so a manifest neither gains nor loses reach by an
         * extension switching doors, and the usage record stays comparable across both. */
        readonly rpc: ContractRouterClient<typeof sandboxContract>;
        request(path: string, init?: RequestInit): Promise<Response>;
        json<T>(path: string, init?: RequestInit): Promise<T>;
        /* READ THROUGH THE HOST'S CACHE, from outside a component, the door for the module-level timers that
         * badge a rail tile, which is where `useQuery` cannot reach.
         *
         * Concurrent callers of one key share a single request, and a caller inside `staleTime` is answered
         * from cache with no round trip at all. Which is what makes this worth using over `json`: a badge that
         * polls a route on its own timer and hands the answer only to itself makes the view it badges for pay
         * for the same read again on open. Through here, the badge's poll IS the view's first paint.
         *
         * The route is gated exactly as `json` is, `queryFn` is your function, and whatever it calls carries
         * its own manifest check. */
        fetch<T>(query: HostQuery<T>): Promise<T>;
        // Whether the active sandbox is currently reachable, reactive when read inside a computed, so it
        // drives host-provided vue-query `enabled` options.
        reachable(): boolean;
        // A cache key scoped to the ACTIVE sandbox, the required prefix for every host-provided vue-query
        // key, so caches never bleed across a sandbox switch.
        key(...parts: readonly string[]): readonly unknown[];
        // The daemon's base URL (its public tunnel origin), for building externally-shareable URLs like webhook
        // endpoints. Undefined until the sandbox has registered its address. Not needed for `request`/`json`
        // (those take a path and inject auth), only when the raw origin must be shown to the user.
        origin(): string | undefined;
        /* THE SIGNED-IN USER'S TRUST TIER on the active sandbox, `owner`, `maintainer`, `collaborator` or
         * `viewer`, reactive when read inside a computed, like `reachable`. For AFFORDANCES ONLY: every route
         * is independently floored by the daemon, so what this gates is whether an Approve button renders, never
         * whether the call would succeed. A view that shows a viewer buttons the daemon will refuse teaches them
         * that buttons lie; this is how a view says less instead.
         *
         * The first consumer is the drafts queue (approve/reject are maintainer-and-up), and it existed as a
         * private composable before it was public API, which is the pattern this package's history warns about:
         * a surface only its own app needs is a surface nobody else can build the same feature on. */
        role(): "owner" | "maintainer" | "collaborator" | "viewer";
    };
    readonly workspace: {
        repos(): readonly RepoFacts[];
        capabilities(): readonly CapabilityFacts[];
        onDidChange(listener: () => void): Disposable;
        /* A REF MOVED IN ONE OF THESE REPOS, a commit, a branch, a checkout, a rebase, an aborted merge.
         *
         * Separate from `contributes.files` because no file contribution could ever carry it: the daemon's
         * watcher descent-ignores `.git`, so a changed ref produces no `workspaceChanged` path to match a prefix
         * against. The daemon diffs the git dirs itself and pushes the repos that moved, exactly as it does for
         * the repo SET (which the same watcher cannot see either, and for the same reason).
         *
         * This matters most for work the user did not do: an agent commits, rebases or lands out-of-band, with no
         * HTTP mutation in this browser to hang an invalidate on. Without this a git surface is only ever as fresh
         * as the last thing the user clicked. `repos` are root-relative ids ("root" is the workspace repo itself).
         */
        onDidChangeRefs(listener: (repos: readonly string[]) => void): Disposable;
        /* OPEN A DIFF IN THE EDITOR AREA, the host's tab strip, beside the files the diff is about.
         *
         * The shell owns the strip, the viewer, the close orchestration and the edit-buffer bookkeeping; the
         * extension owns only the question of what changed. Re-opening the same `key`+`scope`+`path` focuses the
         * tab that is already open rather than stacking a second copy, see DiffPayload for how that identity is
         * built. On mobile, where there is no strip, the host navigates to the diff instead.
         */
        openDiff(payload: DiffPayload): void;
        /* FILL A DIFF OPENED WITH `pending`, the second half of opening a tab before its content exists.
         *
         * Refreshes, never opens: a tab the user has since closed or replaced takes nothing, and the content is
         * simply dropped. That is what makes the pending open safe to use for a slow source, a reader who has
         * moved on to another file is never yanked back to this one, and never has it appear under them.
         */
        fillDiff(payload: DiffPayload): void;
        /* READING AND WRITING WORKSPACE FILES, the daemon's file routes, without the encoding.
         *
         * Extensions keep their durable state in the workspace rather than in settings: an acceptance run's
         * reports, a documentation set's staging tree, the "what has the rail badge already shown" file each of
         * them keeps. That is the right home, it survives a reload, it is shared across the owner's browsers,
         * and the agent writing into it out-of-band is the whole point, but it left every extension spelling
         * `sandbox.json(\`/workspace/file?path=${encodeURIComponent(path)}\`)` and then parsing the envelope out
         * of the answer. Three extensions had five byte-identical copies of that one function.
         *
         * Gated exactly as `sandbox.request`/`sandbox.json` are: these go through the same permission check, so
         * an extension still declares `GET /workspace/file` and `POST /workspace/upload` in its manifest and one
         * that doesn't is still refused. This removes the encoding, not the grant. */
        // The file's text, or undefined when it is not there. Absent is the ordinary FIRST state for most of what
        // extensions keep, nothing has been acknowledged because nothing has been seen, so it is a value here,
        // not a throw every caller would have to wrap. The daemon reports it the same way (a 200 that says the
        // path holds nothing), so a poll over files that do not exist yet is silent rather than a page of failed
        // requests in the owner's console.
        file(path: string): Promise<string | undefined>;
        /* The file parsed as a JSON object, or undefined when it is absent, truncated, or not an object at all.
         *
         * One tolerant reader rather than one per caller. These files are written by agents and editable by
         * hand, so a half-written or hand-mangled one is a case that WILL happen, and "skip it" is the right
         * answer everywhere: one bad file must never blank the surface that reads it. Arrays answer undefined
         * too, every caller of this wants a record. */
        readJson<T>(path: string): Promise<T | undefined>;
        // Create or replace a workspace file. Throws on failure, unlike the reads: a write that silently did
        // nothing would lose the thing the caller was told was saved.
        write(path: string, body: string): Promise<void>;
    };
    // The extension's OWN declared background processes, names outside the manifest are refused.
    readonly processes: {
        status(name: string): Promise<ProcessStatus>;
        start(name: string): Promise<void>;
        stop(name: string): Promise<void>;
    };
    // The shell's ONE global terminal panel, extensions aim it at a tmux session (a capability job, a dev
    // server, an agent terminal); the host owns the panel itself.
    readonly terminal: {
        // Open the panel focused on a tmux session (starting/attaching it).
        open(session: string): void;
        // Show or hide the panel without focusing a session.
        setOpen(open: boolean): void;
    };
    // The shell's chat, the way `terminal` is the shell's one terminal panel: the extension names a transcript,
    // the host owns the tab. What this is for is a record that points at agent work, an automation's run
    // history, an audit row, where "why did it do that" is only answerable by reading the transcript.
    readonly chat: {
        // Open (or focus) the tab for a stored runtime session id, the same path the History menu and the fleet
        // board take. A session the daemon no longer holds opens an empty tab rather than failing.
        openSession(sessionId: string): void;
        /* AIM A NEW CHAT AT A WORKFLOW: the host opens a session exactly as "New agent" does, with the
         * composer's workflow badge set to this design, so the next message the user types becomes that run's
         * request instead of a turn on the chat.
         *
         * It hands over the START of the work rather than performing it, and that is the point. An extension
         * with a Run button used to have two bad options: start the run itself behind its own dialog (a second
         * way to begin agent work, with its own box that looks like nothing else in the product), or navigate
         * to a page about the run. This is the third: the extension names the design, and the user starts it
         * where they start everything else.
         *
         * A workflow id, not a run id, and the id is all it can be: sandbox-contract imports THIS package, so
         * nothing here can name a `Workflow` type.
         */
        composeWorkflow(workflowId: string): void;
        /* AIM A NEW CHAT AT A SAVED LOOP, the same handover as `composeWorkflow` above, for the other kind of
         * design: the host opens a session with the composer's loop badge set, so the next message the user
         * types becomes the loop's GOAL and Send starts it running.
         *
         * It is a separate call rather than a flag on that one because the two badges are separate picks that
         * cannot both be armed, and a single "compose with this id" would have had to guess which kind an id
         * was. A loop id, not a running loop's, nothing has started, and nothing is spent until the send.
         */
        composeLoop(loopId: string): void;
    };
    /* WHICH MODEL A RUN THIS EXTENSION STARTS WILL SPEND, the way `terminal` is the shell's one terminal panel:
     * the extension names the choice it is holding, the host owns the picker.
     *
     * It is an API rather than a kit component because the picker is not a widget, it is a live read of every
     * connected provider's catalog, which credentials the sandbox actually holds, and what each model can do.
     * An extension that rendered its own control could only ever offer a worse list: the acceptance view's did,
     * fetching one provider's models behind a second dropdown for the provider itself, and so it happily
     * offered models the sandbox had no credential for, a run that fails on a credential error minutes later.
     *
     * IT COVERS THE WHOLE CHOICE, provider, account, harness, model, because covering three quarters of it is
     * what produced the copy this API exists to prevent. The automations form asked all four questions, found an
     * API that answered three, and hand-rolled ROWS OF CHIPS for every one of them to keep its own fields
     * consistent with each other: a static provider list that offered providers the sandbox had no credential for
     * and could not offer a model endpoint or an ACP agent at all, and a model row eleven chips wide that grew
     * with every release. Partial coverage does not buy partial reuse; it buys none. */
    readonly models: {
        // What a run opens on when nobody has chosen: the sandbox's Agent-runs model (Sandbox ▸ Agent ▸ Models),
        // falling back to whatever the owner's own chat is set to. Reactive when read inside a computed.
        agentRun(): PickedModel;
        /* NAME A SELECTION THE EXTENSION ALREADY HOLDS, a pin read back from disk, which arrives as bare ids and
         * has to be rendered before anyone opens the picker. This is what keeps `label` honest for the surfaces
         * that SAVE a choice rather than spend it immediately: without it every one of them would keep a catalog
         * to pretty-print its own stored ids, which is the duplication this API exists to end, and it would go
         * stale the day a provider renames a model or the owner disconnects an account.
         *
         * Reactive when read inside a computed, a model that lands in the catalog, or an account that stops being
         * connected, changes what a stored pin should say about itself. */
        describe(selection: {
            readonly provider: string;
            readonly model: string;
            readonly account?: string | undefined;
            readonly harness?: string | undefined;
        }): PickedModel;
        /* Open the picker over `anchor`, a popover on desktop, a sheet on mobile, starting on the selection the
         * caller is holding. Resolves with the pick, or undefined if it was dismissed. A second call supersedes
         * the first, resolving it as a dismissal.
         *
         * EVERY ROW SETTLES IT, including an account and a harness row: each click is one complete answer, so a
         * caller never has to reconcile a half-changed selection, and the picker never has to hold state that
         * disagrees with what the caller is showing. Picking a model under a DIFFERENT provider clears the
         * account with it, an account id is one provider's store key, so carrying it across would pin the run to
         * an account that provider does not have. */
        pick(options: {
            readonly anchor: HTMLElement;
            readonly provider: string;
            readonly model: string;
            readonly account?: string | undefined;
            readonly harness?: string | undefined;
        }): Promise<PickedModel | undefined>;
    };
    // Navigate the shell to an app path (e.g. "/capabilities", "/ext/<view>/<key>").
    readonly navigate: (path: string) => void;
    /* THE URL AS A VIEW'S STATE, so what a reader is looking at can be linked to.
     *
     * A view's own route space is the QUERY, not extra path segments: `/ext/:ext/:key?` is the whole route, and
     * the `:key` segment already means "which activation" (one per repo). A view with internal navigation, a
     * document browser, a selected run, an open file, therefore has nowhere in the path to put it, and without
     * this it could only hold that state in memory, where a reload loses it and a link cannot carry it.
     *
     * Reading is reactive: read inside a computed and the view re-renders when the URL moves, which lets a view
     * DERIVE its state from the query rather than mirror it in a ref (mirroring needs two watchers that can fight
     * each other). Back and forward then work for free, because the URL is the state. */
    readonly route: {
        // The current query, flattened, a repeated key takes its first value, since a view's state is scalar.
        query(): Readonly<Record<string, string>>;
        /* Merge a patch in; a key set to `undefined` is removed. Replaces the history entry by default and pushes
         * a new one when asked: a filter or a display toggle should not fill the back stack, while moving to
         * another document is exactly what Back ought to undo. Other views' params are left alone. */
        setQuery(patch: Readonly<Record<string, string | undefined>>, options?: { readonly push?: boolean }): void;
    };
    readonly theme: {
        mode(): "light" | "dark";
        onDidChange(listener: (mode: "light" | "dark") => void): Disposable;
    };
}

export interface ExtensionContext {
    readonly extensionId: string;
    // Disposables pushed here are disposed on deactivation, in reverse order.
    readonly subscriptions: Disposable[];
}

// The shape of the bundle's default export (or its named exports): `activate` runs once after the engines
// check; `deactivate` runs before the host discards the extension.
export interface ExtensionModule {
    activate(api: IntenticApi, context: ExtensionContext): void | Promise<void>;
    deactivate?(): void | Promise<void>;
}
