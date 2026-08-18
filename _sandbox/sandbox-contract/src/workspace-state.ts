import { STATE_DIR } from "@intentic/constants";
import type { FileContribution } from "@intentic/extension-manifest";
import type { StateFile } from "./state-portability.js";

/* WHICH WORKSPACE FILE BACKS WHICH CORE VIEW — one declaration, read by both sides of the wire.
 *
 * The daemon's own state lives under `<workspace>/.intentic/`, the agent edits it out-of-band with its file
 * tools, and the file watcher pushes every change as a `workspaceChanged` batch. Turning those paths back into
 * "and therefore this view is stale" used to be a hand-written table in the BROWSER (web's systemEventRouting),
 * maintained separately from the paths the daemon actually writes (composition.ts) — two lists of the same
 * fact, in two packages, with nothing tying them together.
 *
 * They drifted, exactly as that shape always does. `.intentic/drafts/` is written by the AGENT (the drafts
 * skill puts a file there) and rendered by the Drafts view, but it was never added to the browser's table — so
 * a draft appearing on disk while the owner watched the page changed nothing until they refocused the tab.
 * Extension settings and the members list were missing for the same reason; writing them out is what showed
 * that neither is a drafts-shaped hole — see their entries.
 *
 * So the binding is declared HERE, once, in the package both the daemon and the browser already import, and
 * each side derives what it needs: the daemon builds its store paths from `path`, the browser builds its
 * invalidation table from `invalidates`. Adding a manifest without saying what it makes stale is now a change
 * to one visible list rather than an omission in a file nobody edits — and `workspace-state.test.ts` fails when
 * a daemon store names a `.intentic` path this list doesn't carry.
 *
 * This mirrors what routes.ts does for the route surface ("nothing is generated and nothing is hand-maintained")
 * one layer over: the same refusal to keep the same knowledge in two places.
 *
 * EXTENSIONS declare their own half in their manifest (`contributes.files`, @intentic/extension-api), in the same
 * two fields, and the browser unions the two lists — see staleQueryKeys. That split is what this table is FOR:
 * before it existed the core enumeration had to carry `automations` and `automation-approvals`, query keys owned
 * by the automations extension, because the extension had no way to say so itself. A key belongs to whoever
 * queries it. */

/* A core entry is an extension's `contributes.files` entry plus the two things only the core list needs: the
 * right to declare NO invalidations (for a daemon-owned file, the answer more often than not), and a
 * portability class, because the daemon's own state is what an environment export has to reason about.
 *
 * `path` is workspace-root-relative, forward-slash — the space `workspaceChanged` paths arrive in. Matching is
 * by PREFIX, which lets one entry cover three shapes without a second matching rule:
 *   - an exact file      `.intentic/settings.json`
 *   - a directory        `.intentic/drafts/`     (one file per draft)
 *   - a name family      `.intentic/environment.custom.` (…Dockerfile and anything later named beside it)
 * A directory entry keeps its trailing slash so it can never prefix-match a sibling file. Entries may NEST —
 * see stateFileFor, which resolves the longest match rather than the first. */
export interface WorkspaceStateFile extends StateFile {
    /* The browser query keys this file's contents feed. EMPTY is a real answer, not a gap — a file the browser
     * renders nothing from, or one deliberately kept off the push path — and `why` says which. Never a prefix
     * test over `.intentic/` as a whole: one stray write must not cost every view a refetch, which is the
     * amplification that once turned an iq index rebuild into an endless request storm. */
    readonly invalidates: readonly string[];
    // Why this file has no invalidations, for the entries that declare none. Absent when it has some.
    readonly why?: string;
    /* Whether this entry is TRACKED by the root repo — the third thing an entry declares, and the one an owner
     * sees most directly: a tracked entry gets a diff in the Changes review and a line in `git log`, so a change
     * to how this sandbox behaves can be read, reverted, and attributed.
     *
     * ABSENT IS THE ANSWER FOR ALMOST EVERYTHING, and deliberately so. The root repo excludes `.intentic`
     * wholesale and this flag is the only thing that carves an entry back out, so a store added later is
     * untracked until someone says otherwise — the same default-deny the `portability` classes are built on, for
     * the same reason. An ignore-pattern list would invert it: a credential store added next month would be
     * committed on its first write, and nothing would have had to change for that to happen.
     *
     * WHAT EARNS IT is one question, asked of the entry rather than of its shape: does a change here change what
     * this sandbox DOES? Two families answer yes.
     *   - CONFIGURATION — the small, slow-moving files that decide how the sandbox behaves: settings, personas,
     *     skills, automations, workflow designs, the environment overlay, which extensions are on.
     *   - AUTHORED CONTENT WHOSE CONSEQUENCES LEAVE THE SANDBOX — a workspace extension is code that runs in the
     *     app with a declared permission surface and a backend of its own; a post draft is words that go out
     *     under the owner's name. Neither is configuration, and reading `versioned` as config-only is what kept
     *     both of them out: an agent could write, and then run, a whole extension with a diff nowhere, and
     *     propose a public post that left no trace once declined. The rule was never "is this a setting", it was
     *     "can this be read, reverted and attributed" — and for the two things the AGENT authors on its own,
     *     that matters more than it does for a file a person edited on purpose.
     *
     * Two kinds of entry stay out on purpose even though they are `carry` and hold no secret:
     *   - LEDGERS (workflow runs, loop iterations, thread bookkeeping, permission-usage batches, held-wake
     *     queues), which are rewritten on a timer or several times per step. Tracking them buries the owner's
     *     code review under machine noise — one of them is written every few seconds while a browser has the app
     *     open. A queue is a ledger too: it records that something was ASKED, and is emptied when it is answered.
     *   - BULK (session transcripts, artifacts), which are hundreds of megabytes of constantly-rewritten
     *     content. They travel in a bundle; they do not belong in a diff.
     * `versioned` is therefore NARROWER than `carry`, and the two answer different questions: carry is "does it
     * move to a new sandbox", this is "should a human review it changing". */
    readonly versioned?: true;
    /* AUTHORED but not configuration — the fourth question an entry can answer, and the narrowest: is this
     * human- or agent-written TEXT that a workspace search should surface? Every `versioned` entry already is
     * (a setting, a persona, a skill — things the agent is asked to find and edit), so this flag exists only
     * for the entries that are authored content without being config: a draft awaiting approval, a staged
     * README, an extension the agent wrote in place. Two of those three are now `versioned` as well, which makes
     * the flag redundant to `SEARCHABLE_STATE_PATHS` on them and is why it stays anyway: searchability is a
     * property of the content, and hanging it on `versioned` would mean a future decision to stop TRACKING a
     * draft silently also stopped anyone FINDING one. Everything else under `.intentic` is machine state, and
     * `SEARCHABLE_STATE_PATHS` below is what lets the search engine deny the rest BY DEFAULT instead of
     * hand-keeping a deny list that goes stale the day a store is added (which is how a 98 kB loop ledger and
     * whole third-party extension checkouts ended up ranking in code search). */
    readonly authored?: true;
    /* WHO BUILDS THIS TREE, when it is not the daemon — an extension, pnpm, another process entirely. Declared
     * on the entry because the coverage guard's second direction ("every declared entry is built somewhere in
     * the daemon") is only meaningful for entries the daemon owns: one it can never build must say who does, or
     * the guard would read the entry as dead. Absent for everything the daemon writes itself. */
    readonly outsideWriter?: string;
}

/* Declared `as const` so the paths survive as literal types (see WorkspaceStatePath below), then published under
 * the interface. Both bindings are needed and neither is redundant: the const is the only thing that can produce
 * the path union, and every consumer reads entries as `WorkspaceStateFile` — an exact-literal tuple loses the
 * optional members (`note`, `why`) on the entries that omit them, which is a worse type for reading than the
 * interface it satisfies. One list, two views of it. */
const STATE_FILES = [
    /* A capability add/remove recomposes the environment overlay and can add or drop a repo's panel.
     *
     * SPLIT ALREADY — and this entry's classification had not caught up, which is the whole of what changed here.
     * It read `secret` on a claim that had stopped being true: that each entry's `config` carries that
     * capability's credential, so the manifest is a secret in full. It does not. capabilities-store.ts's
     * withSecretVault keeps credential VALUES off /work entirely — the manifest holds `__intentic_vaulted__`
     * where one used to be, reads rehydrate so no caller noticed, and main.ts sweeps a hand-written value out at
     * boot. What is left is the SHAPE of a connection: a kind, a URL, a username, a purpose, which permissions a
     * connected computer was granted.
     *
     * WHICH KEYS THOSE ARE IS DERIVED, not listed a second time: `echo` already answers "what of this config may
     * a browser see", and the credential keys are exactly its complement (capabilities/secret-fields.ts). A kind
     * that starts withholding a new field starts vaulting it on the same commit. That is what makes this
     * classification a property of the code rather than a promise to re-audit it — the reason the entry can be
     * reclassified at all, and the reason a hand-kept "these fields are safe" list could not have earned it.
     *
     * `carry`, and this is the entry where that earns the most. composeEnvironment reads its Dockerfile fragments
     * from here, so a bundle that dropped it arrived on a stock overlay with an import report listing every
     * connection to re-add by hand. It now arrives listing them itself, each visibly unconnected and waiting for
     * one credential apiece — the shape personas.json has had all along, for the same reason.
     *
     * `versioned`, which is the point. Connecting this sandbox to a deployment orchestrator, or granting a
     * connected computer shell and screen control, is the largest change anyone makes to what it can DO, and it
     * left a diff nowhere. One consequence worth stating rather than discovering: an identifier that pairs with a
     * credential — Komodo's api key beside its api secret, which its own connector card calls "like a database
     * user" — is echoed, and therefore lands in the diff exactly as a database username would. */
    { path: ".intentic/capabilities.json", invalidates: ["capabilities", "environment", "panels", "manifests"], portability: "carry", versioned: true },

    /* Which workspace-derived recommendations the owner has said "not needed" to, and the evidence each was
     * declined against. It rides the `capabilities` key because the catalog is what changes when one lands, and
     * it travels because a decision about what this workspace does NOT need is as much the owner's as the
     * connections themselves — an export that dropped it would greet them on the target with the same
     * suggestions they had already dismissed. Holds no credential: it is a card name and a file path. */
    { path: ".intentic/capability-dismissals.json", invalidates: ["capabilities"], portability: "carry", versioned: true },

    /* The secret use ledger — one row per moment the agent's exits spent a stored secret (a `{{secret:name}}`
     * reference resolved into a shell command, a value typed into a browser field), joined onto the secrets
     * inventory as each entry's "last used" (sandbox's secrets/secret-uses.ts). Holds names and destinations,
     * never values — which is why it may `carry`: like the automations' run ledger, a use history is about the
     * secrets, and an export that dropped it would arrive claiming none had ever been touched. */
    { path: ".intentic/secret-uses.json", invalidates: ["secrets"], portability: "carry" },

    /* The named personas this sandbox shows the outside world — which connected accounts each one speaks for,
     * what a session wearing it may do, where it works (schemas.ts PersonaSchema). It invalidates `capabilities` as well as
     * its own key because a card and the accounts it names are read together everywhere they are shown: connect
     * a second Reddit and the persona list has a new candidate; remove one and a card points at nothing.
     *
     * It is `carry`, and that is the whole design rather than an oversight — a card is a NAME and a list of ids,
     * never a credential, so it travels to a new sandbox in full while the logins it refers to stay behind. What
     * arrives is a workspace that already knows it has a work-reddit and a studio-x, both visibly unconnected,
     * each waiting for one sign-in. It was also the FIRST file under .intentic the root repo tracked, and the
     * argument it was carved out on — a card is configuration, holds no secret, and belongs in review — is the
     * one `versioned` now generalises to the rest of the config slice (personas/personas-store.ts argues it at
     * length, and its reasoning is why the flag exists rather than a second hand-kept list). */
    { path: ".intentic/personas.json", invalidates: ["personas", "capabilities", "manifests"], portability: "carry", versioned: true },

    /* The overlay Dockerfile, four files that a single `.intentic/environment.` prefix used to cover. They are
     * split here because they answer PORTABILITY differently while answering invalidation identically, and the
     * split is the whole difference between an export that reproduces an environment and one that reproduces a
     * stale copy of it:
     *   - custom is the owner-approved SOURCE OF TRUTH and the only one that must travel;
     *   - approved is COMPOSED from custom + the capability fragments + this container's base image, and is
     *     rewritten on the target's first boot — carrying it would ship a FROM naming an image the target may
     *     not be on (see composeEnvironment's baseImageOf);
     *   - the proposal and the per-tool drafts under environment.d/ are the agent's pending requests, which the
     *     owner has not answered yet; they travel so the question survives the move. */
    { path: ".intentic/environment.custom.Dockerfile", invalidates: ["environment"], portability: "carry", versioned: true },
    { path: ".intentic/environment.Dockerfile", invalidates: ["environment"], portability: "carry", versioned: true },
    { path: ".intentic/environment.d/", invalidates: ["environment"], portability: "carry", versioned: true },
    {
        path: ".intentic/environment.approved.Dockerfile",
        invalidates: ["environment"],
        portability: "derived",
        note: "The target composes its own overlay on first boot; rebuild it there to install the tools it names.",
    },

    { path: ".intentic/settings.json", invalidates: ["settings", "manifests"], portability: "carry", versioned: true },
    // The rule table's last-fired stamps, beside the rules themselves. `derived` rather than `carry`: it is a
    // record of what happened in THIS sandbox, and carrying it to a fresh one would date every rule to work
    // that machine never did.
    {
        path: ".intentic/rule-firings.json",
        invalidates: ["rule-firings"],
        portability: "derived",
        note: "Stamps of when each rule last did something; the new sandbox starts its own record.",
    },
    /* Written by the AGENT's file tools (the drafts skill), read by the owner's approval inbox — the one entry
     * here whose whole point is that a change arrives from outside the browser that renders it. `authored`:
     * a draft is text somebody wrote, and "find the reddit draft about X" is an ordinary search.
     *
     * `versioned` because a draft is the furthest-reaching thing the agent writes: these words go out under the
     * owner's name, to an audience, and cannot be recalled. The approval inbox already gates that — but a gate is
     * not a record. Declining one used to erase it, so the question "what has this agent tried to post" had no
     * answer at all, and an approved post's own history (what was proposed, what the owner changed, when it
     * actually went) lived only in a file nobody could diff.
     *
     * It costs almost nothing to track, which is why the ledger objection does not reach it: a draft is one small
     * file per post, it is written a handful of times across its whole life (proposed → approved → posted, with
     * `postedAt`/`postedUrl` stamped at the end), and it is KEPT afterwards rather than consumed — so tracking
     * yields a durable record instead of the add/delete churn a queue would produce. Nothing in a draft is a
     * credential: it is a platform, a target URL and the body itself, all of it bound for publication anyway. */
    { path: ".intentic/drafts/", invalidates: ["drafts"], portability: "carry", versioned: true, authored: true },
    // ---- declared by the extension that renders them (contributes.files), not here ----
    // The path is the DAEMON's (automations-store writes both), the query keys are the intentic.automations
    // extension's. It declares them in its own manifest and the browser unions the two lists, so uninstalling
    // the extension takes its invalidations with it instead of leaving a rule for a view that no longer exists.
    {
        path: ".intentic/automations.json",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files — `automations` is its query key, not core's.",
        portability: "carry",
        versioned: true,
    },
    /* The run history, keyed by automation id — the LEDGER half of what automations.json used to be, and split
     * out of it for the one reason this table's `versioned` note already gives: a tracked file must be worth
     * reviewing. A scheduled automation records a run every time it fires, so every fire dirtied the manifest
     * the owner reviews, and the run records went into `git log` with it — timestamps and conversation ids
     * committed beside the prompt they belong to, burying an actual edit to the automation's config under
     * machine noise. Config is now the only thing in the tracked file, and a fire touches nothing tracked.
     *
     * It is `carry` for the same reason the workflow ledger is: a run history is about the automation, not about
     * the machine, and an export that dropped it would arrive claiming every automation had never run.
     *
     * Its invalidation is the extension's, exactly like the manifest above — and it has to be DECLARED there
     * rather than inherited, because the row renders its run history from this file now: without its own entry
     * a completed run would stop refreshing the view the moment it stopped living in automations.json. */
    {
        path: ".intentic/automation-runs.json",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files — `automations` is its query key, not core's.",
        portability: "carry",
    },
    {
        path: ".intentic/approvals/",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files — `automation-approvals` is its query key, not core's.",
        portability: "carry",
    },
    /* The maintenance ledger and probe evidence, written by the daemon's chores-store and rendered by the
     * intentic.maintenance extension — the automations shape exactly: the path is the daemon's, the query keys
     * (`maintenance-report`, `maintenance-runs`) are the extension's own contributes.files. Point-in-time
     * evidence about this workspace, so `carry` like the run ledgers: an export that dropped it would arrive
     * claiming no chore had ever been checked. */
    {
        path: ".intentic/chores/",
        invalidates: [],
        why: "Declared by the intentic.maintenance extension's contributes.files — `maintenance-report`/`maintenance-runs` are its query keys, not core's.",
        portability: "carry",
    },
    /* The documentation STAGING tree (documentation extension's paths.ts): generation writes here, the owner
     * reads and approves here, publishing copies into the repo. `authored` is the whole nature of the entry —
     * these are draft READMEs, drafts-shaped in every way that matters, and "find the staged page about X" is
     * as ordinary a search as finding a post draft. */
    {
        path: ".intentic/docs/",
        invalidates: [],
        why: "Declared by the intentic.documentation extension's contributes.files — `documentation`/`documentation-runs` are its query keys, not core's.",
        portability: "carry",
        authored: true,
        outsideWriter: "the intentic.documentation extension's staging writes (its paths.ts)",
    },
    /* The workflow designs and their run ledger became CORE keys the day runs got cards on the fleet board and
     * a mode of the chat panel (web's useWorkflowRuns): those surfaces exist whether or not the workflows
     * extension is enabled, so their freshness cannot ride an extension's contributes.files — an owner turning
     * the extension off would have frozen the board's run cards mid-run. This push is the ONLY live feed the
     * run surfaces have: the scheduler writes the ledger several times per step and nothing polls for it.
     * The runs file invalidates `workflows` too, because GET /workflows embeds each design's runs
     * (WorkflowSummary) — a settled step changes that answer as surely as an edited design does. */
    { path: ".intentic/workflows.json", invalidates: ["workflows"], portability: "carry", versioned: true },
    { path: ".intentic/workflow-runs.json", invalidates: ["workflows", "workflow-runs"], portability: "carry" },
    /* The SAVED loops, which are a manifest and so the opposite of the ledger below them: a handful of entries
     * a person authors, read by two surfaces at once — the workflows page that owns them, and every chat
     * composer's loop picker. Those two are in different windows as often as not (a popped-out chat is its own
     * window), so an edit made on the page has to reach a picker nobody is going to think to reopen. A CORE key
     * rather than the workflows extension's, for the reason the workflow designs beside it are: the composer
     * lists saved loops whether or not that extension is switched on. */
    { path: ".intentic/loop-designs.json", invalidates: ["loop-designs"], portability: "carry", versioned: true },
    {
        path: ".intentic/loops.json",
        invalidates: [],
        why: "Ralph loops and their iteration history. Nothing observes it: where a RUNNING loop stands rides on the fleet roster (AgentSummary.loop), which the /events stream already pushes about once a second, and a second source invalidating on this file could only ever disagree with the card beside it. The iteration list of an ENDED loop is an on-demand read — nothing renders it until someone opens it (web's useLoops, which holds no query for exactly this reason).",
        portability: "carry",
    },

    /* ---- reached by no query, for reasons that are not oversights ----
     *
     * This channel's currency is a QUERY KEY, and invalidation only reaches a query something is observing.
     * Both entries below are outside that by design, so an empty set is the honest record — naming a key no
     * query uses would put the drift this table exists to remove straight back into it. Each says which
     * constraint would have to move first, so the next reader doesn't re-derive it. */
    {
        path: ".intentic/webchat-installs.json",
        invalidates: [],
        why: "Which origins have loaded a Doorbell's widget, written on a 30s flush timer while a customer's site serves page views. The install panel that renders it fetches on open and polls itself while it is on screen, which is the whole window in which the answer changes for anyone. Pushing instead would bill every connected browser a refetch per flush, for a panel almost nobody has open.",
        portability: "carry",
    },
    {
        path: ".intentic/thread-sessions.json",
        invalidates: [],
        why: "Thread bookkeeping (an inbound thread — a Doorbell visitor, a Discord or Slack channel — → sandbox conversation + provider session), written on EVERY inbound message. Nothing in the browser reads it: what a thread produces is a conversation, and the fleet board already learns about that from the agent registry's own push. Naming a key here would bill every connected browser a refetch per inbound message — the request storm this table's own note warns about — to refresh nothing it can see.",
        portability: "carry",
    },
    /* SPLIT, so that "what an extension is configured to do" and "the token it does it with" stop being one file.
     *
     * This entry used to be `secret` and untracked, classed by what a value COULD hold: values are a primitive
     * union an extension chooses the meaning of, and "an API key for the service I talk to" is squarely within
     * it. That classification was honest about the risk and wrong about the file — it meant an extension's whole
     * configuration was unreviewable because one of its keys might be a credential, AND the credential was in
     * there anyway, in a file the workspace API does not lock. A turn could simply read it.
     *
     * A descriptor already says which keys those are (`contributes.settings[].secret`), so the values it names
     * now live in the vault off /work and this file keeps the rest — the capability manifest's split, applied to
     * the same problem one table over (extensions/extension-settings.ts holds it, and the reasoning). Reads
     * rehydrate, so no caller changed.
     *
     * What the split earns: `carry`, because what is left is an extension's configuration and a bundle should
     * arrive with it; and `versioned`, because turning an extension's behaviour on is a decision, and the file
     * that records it can now be read without reading anybody's token. The boot sweep is what keeps that true of
     * a file the agent can also edit — see vaultExtensionSettingSecrets.
     *
     * NO `note`, and the split is why: a note is printed by the import report beside a SKIPPED entry, so an entry
     * that carries can never show one. "Re-enter the credentials" is now the vault's instruction to give, and the
     * vault is under `.intentic/auth/` — which is skipped, and says so there. */
    {
        path: ".intentic/extension-settings.json",
        invalidates: [],
        why: "Held in a module-level shallowRef store per extension (web's extensionSettingsStore) with no query observer, and deliberately so: api.settings.get must answer SYNCHRONOUSLY from an extension's first activate() line, and the store outlives every component scope. A module-level QueryObserver is the one shape that would make invalidation refetch, and this app already ruled it out — it detaches on the queryClient.clear() at logout (see useSandbox's sandbox-list mirror). So a remote member's setting edit reaches this browser on its next load, not live.",
        portability: "carry",
        versioned: true,
    },
    /* Unlike the settings file above it, the on/off switch IS observed by a query — the Extensions tab's list,
     * which carries each row's switch position — so a flip made elsewhere (another member, the agent writing the
     * file) shows up here live. It does not re-run the host: activating or retiring an extension is the loader's
     * reconcile, which the tab's own toggle triggers, so a remote flip takes effect on this browser's next load. */
    {
        path: ".intentic/extension-enablement.json",
        invalidates: ["extensions"],
        portability: "carry",
        versioned: true,
    },
    /* Workspace extensions: one directory per extension, consumed straight from the workspace — no clone, no
     * install moment. Written like drafts, by the agent's own file tools (which is the point: an agent authors
     * an extension and it is live for the daemon and every session at once, since .intentic is shared), so this
     * push is what makes one appearing or changing show up on the Extensions tab while the owner watches.
     * `authored` for the same reason as drafts: this is source the agent wrote and will be asked to find —
     * unlike `.intentic/extensions/` below, which is CLONES of source that lives elsewhere.
     *
     * `versioned` FOR THAT SAME REASON, which is the whole argument. Every other load path an extension can take
     * is already reviewable by construction: a git-installed one is a sha in `capabilities.json` that an owner
     * approved, a baked one shipped in the image. This one is neither — it is code that appears because an agent
     * wrote a file, runs in the app on the owner's session, may register a rail tile, and may serve HTTP from a
     * node process with the workspace under `node:fs` and whatever `permissions.daemon` names. Untracked, the
     * switch that turns it on was in `git log` (extension-enablement.json, below) while the thing being switched
     * on was not: a commit could record enabling something nobody else could read. It is also the one extension
     * kind with no install moment to review at, so the diff is the only review there is.
     *
     * Not a ledger and not bulk: a handful of small authored files per extension, written when someone edits them.
     * The daemon restarts the backend host on a change here, so an edit is already a consequential event — this
     * makes it a legible one. */
    { path: ".intentic/workspace-extensions/", invalidates: ["extensions"], portability: "carry", versioned: true, authored: true },
    /* What the registry comparison found per installed extension (update available / advisory / post-update
     * health), written by the periodic check and by the update/revert transactions — pushed to the tab because
     * an advisory that auto-disabled something must not wait for a reload to be seen. */
    { path: ".intentic/extension-updates.json", invalidates: ["extensions"], portability: "carry" },
    /* The owner's per-extension update posture (notify / agent / auto, and the advisory opt-out). Carried:
     * it is a decision about the extension, not about this machine. */
    { path: ".intentic/extension-update-policy.json", invalidates: ["extensions"], portability: "carry", versioned: true },
    /* Carried, because the evidence is about the extension rather than about the machine: an export that dropped
     * it would arrive claiming every permission was unused, which is worse than arriving with no figures at all. */
    {
        path: ".intentic/extension-usage.json",
        invalidates: [],
        why: "Which of the routes each extension DECLARED it has actually called — the evidence behind the permissions list on its row. The one entry here whose empty set is a RATE decision rather than an architectural one: every browser with the app open reports its batch on a timer, so wiring this to the `extensions` query would refetch the whole list every few seconds for a figure nobody is watching change. The tab reads it when it loads, which is when anyone is reading it.",
        portability: "carry",
    },
    /* THE ONE ENTRY WHERE "HOLDS NO CREDENTIAL" IS TRUE AND `versioned` IS STILL WRONG, which is worth stating
     * because it looks like the two above it: an email and a role per row, nothing to vault, and "who may drive
     * this sandbox" is as consequential a fact as any this table tracks.
     *
     * It stays out for two reasons that are not about secrecy. It is a MIRROR — the platform's invite records are
     * the grant, this is the copy the enforcer keeps so a grant it never received is never honoured, and a change
     * here is the two disagreeing rather than anyone deciding something. Review of the decision already exists,
     * on the Access tab, against the record that is authoritative. And tracking it would mean reclassifying it
     * `carry` to satisfy the guard, which is the one thing it must never be: an access list that travelled would
     * let a source sandbox hand itself the target's ownership. Widening the guard for this single entry is the
     * worse trade — it protects every `identity` entry, and most of those ARE credentials. */
    {
        path: ".intentic/members.json",
        invalidates: [],
        why: "Not this view's source at all: SandboxAccess renders the PLATFORM's invite records (apiClient.invite.list), and this file is the daemon's ENFORCED copy — written first so a grant the enforcer never got is never recorded, then never read back. A change here means the two disagreed, which the write order makes fail-closed rather than stale.",
        portability: "identity",
        note: "Re-invite collaborators from the Access tab — a grant is the platform's record, and the target enforces its own copy.",
    },

    // ---- daemon-owned, nothing derives from watching them ----
    /* Keep credentials and conversation state in disjoint top-level trees. Provider homes are intentionally
     * classified as a single secret unit: several CLIs mix OAuth, config, and provider-native thread metadata,
     * and no generic export can safely distinguish those files. The broad root also makes a newly-added provider
     * secret by construction instead of relying on another hand-maintained provider-name list.
     *
     * IT IS NO LONGER ONLY THE AI LOGINS. Both credential splits put their vault here — `capability-secrets.json`
     * and `extension-secrets.json`, sited beside the provider homes precisely because this tree is already
     * outside the file routes, the workspace walk and the search index (composition.ts sites them, and the two
     * stores argue why). So this is now the ONE entry a secret-less bundle leaves behind, and its note is
     * therefore the only place the owner is told what to re-enter: the manifests that name those connections
     * travel, and would otherwise arrive looking complete. */
    {
        path: ".intentic/auth/",
        invalidates: [],
        why: "AI-provider credentials and runtime homes, plus the capability and extension-settings secret vaults; each account is rendered through owner-gated provider routes.",
        portability: "secret",
        note: "Sign the agent's AI accounts in again on the Agent tab, then re-enter each connection's credential on Capabilities and each extension's secret settings on Extensions — both arrived listed but unauthenticated.",
    },
    /* Agent session transcripts, rewritten on every streamed token.
     *
     * The memory notes under it (`projects/<slug>/memory/**`) ARE user-facing and the /memory view polls them
     * every 30s, which is the one place in this table where a poll survives a real change feed being available.
     * It stays a poll deliberately: the watcher's exclusion is a DESCENT filter, so reaching those notes means
     * letting it walk `.intentic/sessions/claude` → `projects` → every project slug. Measured on the live
     * workspace that is +119 watched directories against ~593 today (a fifth more), with 314 continuously-
     * rewritten transcripts inside the newly-watched set, to make ONE memory directory live. Notes change at
     * agent-turn cadence, so the poll costs a request a minute and the alternative costs a permanent 20% on the
     * watcher. */
    {
        path: ".intentic/sessions/claude/",
        invalidates: [],
        why: "Agent session transcripts — see the note above on why the memory notes under it stay polled.",
        portability: "carry",
    },
    {
        path: ".intentic/artifacts/",
        invalidates: [],
        why: "Durable outputs owned by conversations and extension runs: attachments, browser captures, generated images, acceptance reports, workflow step reports, voice transcripts, and loop ledgers.",
        portability: "carry",
    },
    {
        path: ".intentic/cache/",
        invalidates: [],
        why: "Rebuildable indexes and caches — the iq index and its vector sidecar, the whisper model; ignored by the watcher and recreated from carried workspace content.",
        portability: "derived",
    },
    /* Connector and extension scratch, one directory per extension under runtime/extensions/<id>
     * (extensionRuntimeDir below — the ONLY way an extension names a home here, so a new one lands under its
     * own id by construction instead of minting a file at the .intentic root). Resume watermarks, cached
     * hour-tokens, gateway discovery state: all of it either expires or re-establishes itself, and classifying
     * the root once is what keeps a token an extension caches tomorrow out of bundles without a second edit. */
    {
        path: ".intentic/runtime/",
        invalidates: [],
        why: "Extension runtime scratch (watermarks, cached short-lived tokens); nothing renders it and gateways re-derive it.",
        portability: "derived",
        outsideWriter: "extensions, through extensionRuntimeDir below",
    },
    {
        path: ".intentic/tmp/",
        invalidates: [],
        why: "Scratch that agents and tools leave behind (build logs, demo checkouts); nothing reads it after the turn that wrote it. The state janitor empties it at boot.",
        portability: "derived",
    },
    /* Not written by the daemon at all: pnpm auto-creates its content-addressable store at the project's
     * mountpoint, and `.intentic` is its own mount in an isolated turn — so an install run from under it mints
     * this. Declared anyway, because the table's job is to say what everything under `.intentic` IS: hardlink
     * sources a fresh install rebuilds, which an export must not ship (it reached 1.3 GB on the workspace this
     * entry was written against). */
    {
        path: ".intentic/.pnpm-store/",
        invalidates: [],
        why: "pnpm's content-addressable store, auto-created by installs run from under .intentic; the next install rebuilds it.",
        portability: "derived",
        outsideWriter: "pnpm itself, when an install runs from under .intentic",
    },
    {
        path: ".intentic/newest-run.json",
        invalidates: [],
        why: "The newest daemon version that ever ran this workspace (store/newest-run.ts) — a downgrade tripwire, about THIS sandbox the way rule-firings is.",
        portability: "derived",
        note: "The target stamps its own daemon version on first boot.",
    },
    {
        path: ".intentic/verify.json",
        invalidates: [],
        why: "The dependency verifier's verdict memory; nothing renders it directly — outcomes reach the owner as activity entries and workspace events.",
        portability: "carry",
    },
    {
        path: ".intentic/verify/",
        invalidates: [],
        why: "A running check's wrapper artifacts (log + exit status), read once by the daemon when the panel finishes.",
        portability: "derived",
    },
    {
        path: ".intentic/ci.json",
        invalidates: [],
        why: "Webhook secret + conclusion memory; the Pipelines view reads it through /ci/runs, not off disk.",
        portability: "secret",
        note: "Re-add the CI webhook on the Pipelines view — its secret is per-sandbox.",
    },
    {
        path: ".intentic/control-tokens.json",
        invalidates: [],
        why: "Hashed control tokens (the ACP editor bridge, and anything else driving this sandbox from outside), listed on demand by the owner.",
        portability: "identity",
        note: "Mint fresh control tokens — the old ones authenticate against the source sandbox.",
    },
    {
        path: ".intentic/owner.json",
        invalidates: [],
        why: "Bound once on first use; a change here means the sandbox was re-owned, which re-authenticates anyway.",
        portability: "identity",
    },
    {
        path: ".intentic/workspace.json",
        invalidates: [],
        why: "The workspace identity, read from the /events hello frame rather than as a file.",
        portability: "identity",
    },
    {
        path: ".intentic/templates.json",
        invalidates: [],
        why: "Scaffold templates, read when the scaffold dialog opens.",
        portability: "carry",
        versioned: true,
    },
    /* Classed `derived` for size rather than for safety, and it is the one entry where that costs the owner
     * something real: the profiles ARE logged-in sessions. They are also gigabytes of a store Chromium rewrites
     * constantly and versions against its own build, so carrying them ships bulk that the target's Chromium may
     * refuse anyway. The note is what keeps the loss visible instead of silent. */
    {
        path: ".intentic/browser/",
        invalidates: [],
        why: "Browser-login profiles: Chromium rewrites these constantly. Descent-ignored by the watcher outright.",
        portability: "derived",
        note: "Log the agent's browser back into any site it needs — profiles do not travel.",
    },
    {
        path: ".intentic/extensions/",
        invalidates: [],
        why: "Extension checkouts — whole git clones. The `extensions` query is driven by the capability manifest above, not by their contents.",
        portability: "derived",
        note: "Extensions re-clone from the capability manifest on the target's next reconcile.",
    },
    { path: ".intentic/plugins/", invalidates: [], why: "Agent plugin dirs, read by the SDK's loader each turn.", portability: "carry" },
    /* THE SKILLS THE OWNER WROTE THEMSELVES, one directory per skill — the source of truth the reconciler copies
     * into `.agents/skills` for the ones currently switched on (settings.json's `skills` list). It is here rather
     * than in the loaded folder for the reason the plugin dirs are: that tree holds only what is currently ON,
     * and a skill switched off has to keep its text somewhere the loaders will not read it from.
     *
     * `versioned`, like the rest of the config slice: a skill changes how the agent behaves, so it earns a diff
     * in the Changes review and a line in `git log` the same way a rule or a persona does. `carry` for the same
     * reason — it is text the owner wrote, with no credential in it and nothing about this machine. */
    { path: ".intentic/skills/", invalidates: ["skills"], portability: "carry", versioned: true },
    /* ONE FOLDER PER PERSONA — what a session wearing that card is told, and the skills and tools only it gets.
     * Laid out as a Claude Code plugin (`.claude-plugin/plugin.json`, `skills/`, `agents/`, `commands/`,
     * `hooks/`, `.mcp.json`) so the runtime's own loader reads it and this daemon parses none of it, exactly as
     * the plugin checkouts above are read (personas/persona-kit.ts).
     *
     * A SECOND ENTRY BESIDE `personas.json` RATHER THAN A FIELD INSIDE IT, because the two are different kinds
     * of thing to review. The card is a name, some ids and some switches — a few lines that diff cleanly. This
     * is prose and files: a system prompt, a skill, a subagent. Folding a 20k prompt into the JSON would make
     * every persona edit an unreadable diff and put text somebody wrote inside a record nobody writes by hand.
     *
     * `versioned` and `carry` for the same reasons the card and the skills above are: it changes how the agent
     * behaves, it holds no credential, and it belongs in a pull request — which is also what makes it
     * searchable, since every versioned entry already is. */
    { path: ".intentic/personas/", invalidates: ["personas"], portability: "carry", versioned: true },
] as const satisfies readonly WorkspaceStateFile[];

export const WORKSPACE_STATE_FILES: readonly WorkspaceStateFile[] = STATE_FILES;

/* The entries the root repo tracks, workspace-root-relative and in declaration order — what history.ts turns
 * into the negations that carve them back out of the wholesale `.intentic` exclusion.
 *
 * Derived rather than written down beside the exclude rule, for the reason this whole file exists: the git rule
 * lives in the daemon and the classification lives here, and a second hand-kept copy of "which config is
 * reviewable" is a copy that goes stale the first time someone adds a store. Marking an entry `versioned` is now
 * the entire change — the exclude list follows on the next boot, in both places it is written. */
export const VERSIONED_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.versioned).map((file) => file.path);

/* The `.intentic` slice a workspace SEARCH may surface: configuration a person reviews (`versioned`) plus the
 * authored-content dirs (`authored`) — drafts, staged docs, workspace extensions. Everything else under
 * `.intentic` is machine state, and the search engine (iq's floor) denies it BY DEFAULT off this list, the
 * same default-deny the portability classes are built on and for the same reason: a deny list is a list a new
 * ledger is forgotten from, and the forgetting is silent — it ranked loop iteration history and cloned
 * third-party extension source against the user's own code for months before this derivation existed.
 *
 * WHAT THE CREDENTIAL SPLITS MOVED ACROSS THIS LINE, since the note that used to sit here said the opposite and
 * was worth replacing rather than deleting. `capabilities.json` was `secret` and unversioned, and the sentence
 * celebrated that the index therefore stopped copying capability tokens into search text. It is `versioned` now
 * and searchable — and the guarantee is unchanged, because the tokens are not in the file any more. The floor
 * moved from "keep the index away from the file that holds credentials" to "the file holds none", which is the
 * stronger of the two: it also holds for the shell, which never consulted this list at all. `auth/` — where those
 * values went, both vaults included — is still denied, and is the entry that was doing the real work all along. */
export const SEARCHABLE_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.versioned || file.authored).map(
    (file) => file.path,
);

/* THE ONE WAY AN EXTENSION NAMES ITS SCRATCH HOME — `.intentic/runtime/extensions/<id>`, workspace-relative
 * and forward-slash so the browser bundle can hold it too; callers join it onto whatever root is in force.
 *
 * It exists for the reason statePath does one table over: before it, every gateway spelled the layout itself
 * and one extension (deployments) simply didn't, minting `komodo.json` at the `.intentic` root where nothing
 * classified it. An extension that composes through this helper cannot land outside its own directory, so the
 * runtime/ entry's `derived` covers whatever it writes tomorrow. Extension ids are validated slugs already;
 * the replace is defence in depth against a path ever being built from something else. */
export const extensionRuntimeDir = (extension: string): string => `${STATE_DIR}/runtime/extensions/${extension.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;

/* The manifests whose problems the unreadable-manifest notice SHOWS — the handful a person hand-edits — and the
 * one fact that decides it is already in the table above.
 *
 * Every store reads through the same `jsonFile`, so every store reports what it could not make sense of, and for
 * a long time the notice showed all of them. That is wrong twice over. Its advice — fix the file and this clears
 * on its own — is addressed to somebody holding an editor, which is true of `settings.json` and false of a
 * daemon-written LEDGER nobody opens: a run history that stopped matching a schema the build tightened is not a
 * mistake the owner made, and the card asked them to repair sixty kilobytes of machine JSON by hand. Worse, a
 * file that reports into the notice without feeding the notice's QUERY leaves a complaint no write can refresh,
 * so it sits on screen until the daemon restarts — which is exactly how the workflow ledger's entry became
 * permanent furniture.
 *
 * Both follow from one rule, which is why this derives rather than lists: a file's problems are shown IFF a write
 * to that file refreshes the notice. Declaring `manifests` in `invalidates` is the entire opt-in, so the edit
 * that puts a file on the card is the same edit that keeps it current, and neither can be done without the
 * other. A ledger that breaks still falls back and still sets its unreadable bytes aside on the next write
 * (store/json-file.ts) — it just stops asking the owner to fix it. */
export const REPORTED_MANIFEST_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.invalidates.includes("manifests")).map(
    (file) => file.path,
);

// Accepts either separator, like isLockedWorkspacePath below: the daemon holds these as platform paths and makes
// them relative at the last moment, and normalizing at each call site is the one that eventually gets forgotten.
export const isReportedManifest = (relPath: string): boolean => REPORTED_MANIFEST_PATHS.includes(relPath.replaceAll("\\", "/"));

/* Old directory names are never read or migrated. Keep that finite set in one quarantine record so access,
 * export, and search cannot reinterpret abandoned machine state as ordinary workspace content after a rename.
 * `artifacts` still carry; the distinction here tells portability only which retired roots are secrets or
 * derived — and tells the state janitor which it may DELETE: a retired `derived` root is a rebuildable cache
 * by its own classification, so leaving 466 MB of abandoned model where only a manual `rm` reaches it was
 * quarantine doing half its job. Secret and artifact roots stay until an owner removes them by hand: deleting
 * content is not the janitor's call, only deleting what the class already says is disposable. */
export const RETIRED_WORKSPACE_STATE_DIRS = {
    secret: ["claude", "codex", "kimi", "opencode", "cliproxy"],
    derived: ["iq", "extensions-runtime", "whisper", "browser/output"],
    artifacts: ["attachments", "acceptance", "loops", "workflow-runs", "transcripts"],
} as const;

/* THE DAEMON'S OWN CONTROL PLANE — the entries directly under the workspace root's `.intentic/` that the file
 * API refuses to read, write, move or delete for anyone, the owner included (workspace/workspace-files.ts holds
 * the enforcement and the full reasoning for each name).
 *
 * The list lives HERE, in the package both sides import, because the browser has to draw the same rule the
 * daemon enforces. It didn't, and the gap was a small piece of theatre: the explorer listed `capabilities.json`
 * like any other file, opening it flashed a tab, the read came back with nothing there, and the tab closed
 * itself — a refusal acted out as a glitch. A file the app will not open should say so before it is clicked,
 * which takes a rule the explorer can consult, not a status code it can only react to.
 *
 * Naming these to the browser gives nothing away that the tree did not already publish — it listed them, sizes
 * and all. What stays behind the guard is the only thing that ever mattered: the bytes. */
const LOCKED_STATE_ENTRIES: ReadonlySet<string> = new Set([
    "owner.json",
    "members.json",
    "capabilities.json",
    "ci.json",
    "claude.json",
    "auth",
    "sessions",
    "browser",
    ...RETIRED_WORKSPACE_STATE_DIRS.secret,
]);

/* Whether a workspace-root-relative path lands in that control plane — and so is shown locked rather than
 * opened. Scoped deliberately tight, matching the guard: only the ROOT `.intentic` counts (a repo's own nested
 * one is ordinary content) and only these entries within it, subtrees included, so a new provider dropped under
 * `auth/` is covered without a second edit.
 *
 * The ROOT's own `.git` joins them. It is the pointer to the shadow history repo kept off the workspace so the
 * agent cannot rewrite its own past; a NESTED repo's `.git` is ordinary content and stays browsable.
 *
 * Accepts either slash so a caller holding a platform path doesn't have to normalize first. */
export const isLockedWorkspacePath = (relPath: string): boolean => {
    const segments = relPath.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
    if (segments[0] === ".git") {
        return true;
    }
    return segments.length >= 2 && segments[0] === STATE_DIR && LOCKED_STATE_ENTRIES.has(segments[1] ?? "");
};

/* Every path this table declares, as a type. `as const` above is what makes it one, and it is what finally makes
 * the first sentence of this file's header TRUE rather than aspirational.
 *
 * "The daemon builds its store paths from `path`" was the design; the code did not. `composition.ts` and twenty
 * files beside it spelled the same layout a SECOND way — `join(root, ".intentic", "settings.json")` — with
 * nothing tying the two spellings together. Rename a store's file and this table keeps declaring the old name:
 * no error, no failing test, just a view that quietly stops refreshing, which is the exact failure the table was
 * written to end and the exact way drafts went missing.
 *
 * So the daemon joins through `statePath` (workspace/state-paths.ts), which takes one of THESE and nothing else.
 * A rename is now a compile error at every site that names the file, in both packages, or it is not a rename. */
export type WorkspaceStatePath = (typeof STATE_FILES)[number]["path"];

/* The query keys a batch of changed paths makes stale, deduped and stable. The browser's `/events` handler calls
 * this; keeping it here rather than in the web means the rule is unit-testable without a query client, and the
 * daemon can assert against the same table.
 *
 * `contributed` is what the ACTIVATED extensions declared in `contributes.files` — passed in rather than
 * imported, because which extensions are live is a browser fact this package has no way to know. It is a
 * required argument for the same reason: an added second source that callers may forget is a source that
 * silently does nothing, which is the failure this whole file exists to remove. Extension entries are unioned
 * flat with the core ones, not layered over them: both lists describe the same fact about the same file, and a
 * path can legitimately match one entry in each — a core prefix that invalidates nothing must not veto a
 * narrower extension entry beneath it, or everything under one of the daemon's machine-state prefixes would be
 * unreachable to extensions by construction. */
export const staleQueryKeys = (paths: readonly string[], contributed: readonly FileContribution[]): readonly string[] => [
    ...new Set(
        [...WORKSPACE_STATE_FILES, ...contributed]
            .filter((file) => file.invalidates.length > 0 && paths.some((path) => path.startsWith(file.path)))
            .flatMap((file) => file.invalidates),
    ),
];

/* Every query key any watched file feeds — what a NEW /events connection invalidates wholesale (core's table
 * plus the running extensions'). The file push is these keys' ONLY live feed, and a `workspaceChanged` frame
 * produced while the stream was down is a frame nobody will ever resend — so each key's view would sit stale
 * until the file's NEXT write, indefinitely for anything that settled while the browser was away. Re-asking on
 * connect bounds the damage at one cheap read per key, which is what lets those views go entirely unpolled. */
export const fileBoundQueryKeys = (contributed: readonly FileContribution[]): readonly string[] => [
    ...new Set([...WORKSPACE_STATE_FILES, ...contributed].flatMap((file) => file.invalidates)),
];
