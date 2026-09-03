import { STATE_DIR } from "@intentic/constants";
import type { FileContribution } from "@intentic/extension-manifest";
import type { StateFile } from "./state-portability.js";

/* WHICH WORKSPACE FILE BACKS WHICH CORE VIEW, one declaration, read by both sides of the wire.
 *
 * The daemon's own state lives under `<workspace>/.intentic/`, the agent edits it out-of-band with its file
 * tools, and the file watcher pushes every change as a `workspaceChanged` batch. Turning those paths back into
 * "and therefore this view is stale" used to be a hand-written table in the BROWSER (web's systemEventRouting),
 * maintained separately from the paths the daemon actually writes (composition.ts), two lists of the same
 * fact, in two packages, with nothing tying them together.
 *
 * They drifted, exactly as that shape always does. The approvals queue is written by the AGENT (the approvals
 * skill puts a file there) and rendered by the Approvals view, but it was never added to the browser's table,
 * so a proposal appearing on disk while the owner watched the page changed nothing until they refocused the
 * tab. Extension settings and the members list were missing for the same reason; writing them out is what
 * showed that neither is an approvals-shaped hole, see their entries.
 *
 * So the binding is declared HERE, once, in the package both the daemon and the browser already import, and
 * each side derives what it needs: the daemon builds its store paths from `path`, the browser builds its
 * invalidation table from `invalidates`. Adding a manifest without saying what it makes stale is now a change
 * to one visible list rather than an omission in a file nobody edits, and `workspace-state.test.ts` fails when
 * a daemon store names a `.intentic` path this list doesn't carry.
 *
 * This mirrors what routes.ts does for the route surface ("nothing is generated and nothing is hand-maintained")
 * one layer over: the same refusal to keep the same knowledge in two places.
 *
 * EXTENSIONS declare their own half in their manifest (`contributes.files`, @intentic/extension-api), in the same
 * two fields, and the browser unions the two lists, see staleQueryKeys. That split is what this table is FOR:
 * before it existed the core enumeration had to carry `automations` and `automation-approvals`, query keys owned
 * by the automations extension, because the extension had no way to say so itself. A key belongs to whoever
 * queries it. */

/* A core entry is an extension's `contributes.files` entry plus the two things only the core list needs: the
 * right to declare NO invalidations (for a daemon-owned file, the answer more often than not), and a
 * portability class, because the daemon's own state is what an environment export has to reason about.
 *
 * `path` is workspace-root-relative, forward-slash, the space `workspaceChanged` paths arrive in. Matching is
 * by PREFIX, which lets one entry cover three shapes without a second matching rule:
 *   - an exact file      `.intentic/config/settings.json`
 *   - a directory        `.intentic/config/approvals/`  (one file per approval)
 *   - a name family      `.intentic/config/environment.custom.` (…Dockerfile and anything later named beside it)
 * A directory entry keeps its trailing slash so it can never prefix-match a sibling file. Entries may NEST,
 * see stateFileFor, which resolves the longest match rather than the first. */
export interface WorkspaceStateFile extends StateFile {
    /* The browser query keys this file's contents feed. EMPTY is a real answer, not a gap, a file the browser
     * renders nothing from, or one deliberately kept off the push path, and `why` says which. Never a prefix
     * test over `.intentic/` as a whole: one stray write must not cost every view a refetch, which is the
     * amplification that once turned an iq index rebuild into an endless request storm. */
    readonly invalidates: readonly string[];
    // Why this file has no invalidations, for the entries that declare none. Absent when it has some.
    readonly why?: string;
    /* Whether this entry is TRACKED by the root repo, the third thing an entry declares, and the one an owner
     * sees most directly: a tracked entry gets a diff in the Changes review and a line in `git log`, so a change
     * to how this sandbox behaves can be read, reverted, and attributed.
     *
     * ABSENT IS THE ANSWER FOR ALMOST EVERYTHING, and deliberately so. The root repo excludes `.intentic`
     * wholesale and this flag is the only thing that carves an entry back out, so a store added later is
     * untracked until someone says otherwise, the same default-deny the `portability` classes are built on, for
     * the same reason. An ignore-pattern list would invert it: a credential store added next month would be
     * committed on its first write, and nothing would have had to change for that to happen.
     *
     * WHAT EARNS IT is one question, asked of the entry rather than of its shape: does a change here change what
     * this sandbox DOES? Two families answer yes.
     *   - CONFIGURATION, the small, slow-moving files that decide how the sandbox behaves: settings, personas,
     *     skills, automations, workflow designs, the environment overlay, which extensions are on.
     *   - AUTHORED CONTENT WHOSE CONSEQUENCES LEAVE THE SANDBOX, a workspace extension is code that runs in the
     *     app with a declared permission surface and a backend of its own; a post draft is words that go out
     *     under the owner's name. Neither is configuration, and reading `versioned` as config-only is what kept
     *     both of them out: an agent could write, and then run, a whole extension with a diff nowhere, and
     *     propose a public post that left no trace once declined. The rule was never "is this a setting", it was
     *     "can this be read, reverted and attributed", and for the two things the AGENT authors on its own,
     *     that matters more than it does for a file a person edited on purpose.
     *
     * Two kinds of entry stay out on purpose even though they are `carry` and hold no secret:
     *   - LEDGERS (workflow runs, loop iterations, thread bookkeeping, permission-usage batches, held-wake
     *     queues), which are rewritten on a timer or several times per step. Tracking them buries the owner's
     *     code review under machine noise, one of them is written every few seconds while a browser has the app
     *     open. A queue is a ledger too: it records that something was ASKED, and is emptied when it is answered.
     *   - BULK (session transcripts, artifacts), which are hundreds of megabytes of constantly-rewritten
     *     content. They travel in a bundle; they do not belong in a diff.
     * `versioned` is therefore NARROWER than `carry`, and the two answer different questions: carry is "does it
     * move to a new sandbox", this is "should a human review it changing". */
    readonly versioned?: true;
    /* AUTHORED but not configuration, the fourth question an entry can answer, and the narrowest: is this
     * human- or agent-written TEXT that a workspace search should surface? Every `versioned` entry already is
     * (a setting, a persona, a skill, things the agent is asked to find and edit), so this flag exists only
     * for the entries that are authored content without being config: a draft awaiting approval, a staged
     * README, an extension the agent wrote in place. Two of those three are now `versioned` as well, which makes
     * the flag redundant to `SEARCHABLE_STATE_PATHS` on them and is why it stays anyway: searchability is a
     * property of the content, and hanging it on `versioned` would mean a future decision to stop TRACKING a
     * draft silently also stopped anyone FINDING one. Everything else under `.intentic` is machine state, and
     * `SEARCHABLE_STATE_PATHS` below is what lets the search engine deny the rest BY DEFAULT instead of
     * hand-keeping a deny list that goes stale the day a store is added (which is how a 98 kB loop ledger and
     * whole third-party extension checkouts ended up ranking in code search). */
    readonly authored?: true;
    /* WHETHER DESKTOP-SYNC COPIES THIS DOWN, the fifth question, and the one `portability` cannot answer even
     * though it looks like it should.
     *
     * Portability asks whether a piece of state may RESTORE into a different sandbox. Backup asks whether it may
     * be COPIED to the owner's own machine so the loss of this sandbox is not the loss of the work. Those read as
     * the same question and are not: `members.json` is the clearest case, and its own entry argues the half that
     * was already written down, an access list that TRAVELLED would let a source sandbox hand itself the
     * target's ownership, which is why it may never be `carry`. None of that reasoning says the owner may not
     * hold a copy of who could drive their own sandbox. Conflating the two is what made the sync ignore the state
     * dir wholesale, so a sandbox that went away took every persona, skill, draft and transcript with it.
     *
     * SO IT DERIVES, and this flag exists only to carve out the entry where the derivation is wrong. The default
     * (backedUp below) is `carry` plus `identity`: ordinary state and the small records that bind this sandbox to
     * its owner. `derived` is excluded for size, it is the caches, the checkouts and the browser profiles, all
     * rebuildable and all bulk, and `secret` is excluded because a credential's exposure is the number of
     * places it exists, and a laptop is one more place.
     *
     * `false` is the only value: an entry either accepts the derived answer or opts out of the copy, and there is
     * no entry that needs opting IN against its class. Anything opting out says why on the entry. */
    readonly backup?: false;
    /* WHO BUILDS THIS TREE, when it is not the daemon, an extension, pnpm, another process entirely. Declared
     * on the entry because the coverage guard's second direction ("every declared entry is built somewhere in
     * the daemon") is only meaningful for entries the daemon owns: one it can never build must say who does, or
     * the guard would read the entry as dead. Absent for everything the daemon writes itself. */
    readonly outsideWriter?: string;
}

/* Declared `as const` so the paths survive as literal types (see WorkspaceStatePath below), then published under
 * the interface. Both bindings are needed and neither is redundant: the const is the only thing that can produce
 * the path union, and every consumer reads entries as `WorkspaceStateFile`, an exact-literal tuple loses the
 * optional members (`note`, `why`) on the entries that omit them, which is a worse type for reading than the
 * interface it satisfies. One list, two views of it. */
const STATE_FILES = [
    /* A capability add/remove recomposes the environment overlay and can add or drop a repo's panel.
     *
     * SPLIT ALREADY, and this entry's classification had not caught up, which is the whole of what changed here.
     * It read `secret` on a claim that had stopped being true: that each entry's `config` carries that
     * capability's credential, so the manifest is a secret in full. It does not. capabilities-store.ts's
     * withSecretVault keeps credential VALUES off /work entirely, the manifest holds `__intentic_vaulted__`
     * where one used to be, reads rehydrate so no caller noticed, and main.ts sweeps a hand-written value out at
     * boot. What is left is the SHAPE of a connection: a kind, a URL, a username, a purpose, which permissions a
     * connected computer was granted.
     *
     * WHICH KEYS THOSE ARE IS DERIVED, not listed a second time: `echo` already answers "what of this config may
     * a browser see", and the credential keys are exactly its complement (capabilities/secret-fields.ts). A kind
     * that starts withholding a new field starts vaulting it on the same commit. That is what makes this
     * classification a property of the code rather than a promise to re-audit it, the reason the entry can be
     * reclassified at all, and the reason a hand-kept "these fields are safe" list could not have earned it.
     *
     * `carry`, and this is the entry where that earns the most. composeEnvironment reads its Dockerfile fragments
     * from here, so a bundle that dropped it arrived on a stock overlay with an import report listing every
     * connection to re-add by hand. It now arrives listing them itself, each visibly unconnected and waiting for
     * one credential apiece, the shape personas.json has had all along, for the same reason.
     *
     * `versioned`, which is the point. Connecting this sandbox to a deployment orchestrator, or granting a
     * connected computer shell and screen control, is the largest change anyone makes to what it can DO, and it
     * left a diff nowhere. One consequence worth stating rather than discovering: an identifier that pairs with a
     * credential. Komodo's api key beside its api secret, which its own connector card calls "like a database
     * user", is echoed, and therefore lands in the diff exactly as a database username would. */
    {
        path: ".intentic/config/capabilities.json",
        invalidates: ["capabilities", "environment", "panels", "manifests"],
        portability: "carry",
        versioned: true,
    },

    /* Which workspace-derived recommendations the owner has said "not needed" to, and the evidence each was
     * declined against. It rides the `capabilities` key because the catalog is what changes when one lands, and
     * it travels because a decision about what this workspace does NOT need is as much the owner's as the
     * connections themselves, an export that dropped it would greet them on the target with the same
     * suggestions they had already dismissed. Holds no credential: it is a card name and a file path. */
    { path: ".intentic/config/capability-dismissals.json", invalidates: ["capabilities"], portability: "carry", versioned: true },

    /* The secret use ledger, one row per moment the agent's exits spent a stored secret (a `{{secret:name}}`
     * reference resolved into a shell command, a value typed into a browser field), joined onto the secrets
     * inventory as each entry's "last used" (sandbox's secrets/secret-uses.ts). Holds names and destinations,
     * never values, which is why it may `carry`: like the automations' run ledger, a use history is about the
     * secrets, and an export that dropped it would arrive claiming none had ever been touched. */
    { path: ".intentic/records/secret-uses.json", invalidates: ["secrets"], portability: "carry" },

    /* The wallet's payment ledger, one row per payment attempt that reached policy (sandbox's
     * wallet/wallet-ledger.ts): what was paid, to whom, how it settled, with the onchain transaction hash
     * when the endpoint stated one. Holds amounts, hosts and addresses, never a credential, the signing key
     * never enters the container at all, so it may `carry`: like the secret-use ledger, a spend history is
     * about the owner's money, and an export that dropped it would arrive claiming none was ever spent. */
    {
        path: ".intentic/records/wallet-ledger.json",
        invalidates: [],
        why: "Rendered through the wallet CLI and the capability card's live status probe, not from a browser query key.",
        portability: "carry",
    },

    /* The named personas this sandbox shows the outside world, which connected accounts each one speaks for,
     * what a session wearing it may do, where it works (PersonaSchema, schemas/personas.ts). It invalidates `capabilities` as well as
     * its own key because a card and the accounts it names are read together everywhere they are shown: connect
     * a second Reddit and the persona list has a new candidate; remove one and a card points at nothing.
     *
     * It is `carry`, and that is the whole design rather than an oversight, a card is a NAME and a list of ids,
     * never a credential, so it travels to a new sandbox in full while the logins it refers to stay behind. What
     * arrives is a workspace that already knows it has a work-reddit and a studio-x, both visibly unconnected,
     * each waiting for one sign-in. It was also the FIRST file under .intentic the root repo tracked, and the
     * argument it was carved out on, a card is configuration, holds no secret, and belongs in review, is the
     * one `versioned` now generalises to the rest of the config slice (personas/personas-store.ts argues it at
     * length, and its reasoning is why the flag exists rather than a second hand-kept list). */
    { path: ".intentic/config/personas.json", invalidates: ["personas", "capabilities", "manifests"], portability: "carry", versioned: true },

    /* The overlay Dockerfile, four files that a single `.intentic/environment.` prefix used to cover. They are
     * split here because they answer PORTABILITY differently while answering invalidation identically, and the
     * split is the whole difference between an export that reproduces an environment and one that reproduces a
     * stale copy of it:
     *   - custom is the owner-approved SOURCE OF TRUTH and the only one that must travel;
     *   - approved is COMPOSED from custom + the capability fragments + this container's base image, and is
     *     rewritten on the target's first boot, carrying it would ship a FROM naming an image the target may
     *     not be on (see composeEnvironment's baseImageOf);
     *   - the proposal and the per-tool drafts under environment.d/ are the agent's pending requests, which the
     *     owner has not answered yet; they travel so the question survives the move. */
    { path: ".intentic/config/environment.custom.Dockerfile", invalidates: ["environment"], portability: "carry", versioned: true },
    { path: ".intentic/config/environment.Dockerfile", invalidates: ["environment"], portability: "carry", versioned: true },
    { path: ".intentic/config/environment.d/", invalidates: ["environment"], portability: "carry", versioned: true },
    {
        path: ".intentic/local/environment.approved.Dockerfile",
        invalidates: ["environment"],
        portability: "derived",
        note: "The target composes its own overlay on first boot; rebuild it there to install the tools it names.",
    },

    { path: ".intentic/config/settings.json", invalidates: ["settings", "manifests"], portability: "carry", versioned: true },
    /* Which agent commands are heavy enough to take turns, and how many may run at once (the daemon reads it
     * per Bash command: platform/heavy-commands.ts).
     *
     * `carry`, because the answer is a property of the WORKSPACE rather than of this machine: `pnpm test` fans
     * out to the same 74 packages wherever the repo is cloned, so a fresh sandbox should arrive already knowing
     * which commands to queue rather than rediscovering it by freezing once.
     *
     * `versioned` for the reason the config slice generally is (personas.json's entry argues it): the file
     * changes at human speed, it holds no secret, and a change to it is exactly the kind a reviewer should see
     * — raising the limit is a decision about everyone's sessions on that box, and `git log` is the only thing
     * that answers "since when have we allowed four of these at once". */
    { path: ".intentic/config/heavy-commands.json", invalidates: ["settings"], portability: "carry", versioned: true },
    // The rule table's last-fired stamps, beside the rules themselves. `derived` rather than `carry`: it is a
    // record of what happened in THIS sandbox, and carrying it to a fresh one would date every rule to work
    // that machine never did.
    {
        path: ".intentic/local/rule-firings.json",
        invalidates: ["rule-firings"],
        portability: "derived",
        note: "Stamps of when each rule last did something; the new sandbox starts its own record.",
    },
    /* The runtime-install ledger: which tools sessions installed into the container at runtime, how often, and
     * the last drift snapshot (environment/runtime-installs.ts). `carry` where rule-firings chose `derived`,
     * because the two record different subjects: a firing is about what THIS machine did, while the ledger is
     * about what this WORKSPACE's tasks keep needing — a workspace moved to a fresh sandbox will hit the same
     * missing tools, and arriving with the recurrence memory is the whole reason it is kept. The drift snapshot
     * inside is machine-scoped, and self-expires on the move: its bornAt can never match the new container. */
    { path: ".intentic/records/runtime-installs.json", invalidates: ["environment"], portability: "carry" },
    /* Where each agent ENGINE's version comes from: the blessed list, upstream's newest, a pin, or the image
     * (schemas/engines.ts). The versions themselves are machine state and live on the daemon's volume, because
     * they are architecture-specific binaries; the POLICY is a decision about this workspace's work and travels
     * with it — a team that pins Claude Code while a regression is open wants that pin to survive the move to a
     * fresh sandbox rather than to be rediscovered by hitting the regression again.
     *
     * `versioned` for the config slice's usual reason (personas.json's entry argues it): it changes at human
     * speed, holds no secret, and "since when have we been tracking upstream's newest on this repo" is a
     * question only `git log` answers. Its own key rather than `environment`'s: the engines card is drawn on
     * that page but reads its own route, and a channel change must not cost every open Environment tab a
     * re-read of the overlay it did not touch. */
    { path: ".intentic/config/engines.json", invalidates: ["engines"], portability: "carry", versioned: true },
    /* Written by the AGENT's file tools (the approvals skill), read by the owner's approval inbox, the one entry
     * here whose whole point is that a change arrives from outside the browser that renders it. `authored`:
     * an approval is text somebody wrote, a post or a description of an action, and "find the reddit post
     * about X" is an ordinary search.
     *
     * `versioned` because an approval is the furthest-reaching thing the agent writes: a post goes out under the
     * owner's name, to an audience, and cannot be recalled; an action spends or sends or deletes. The inbox
     * already gates that, but a gate is not a record. Declining one used to erase it, so the question "what has
     * this agent tried to do" had no answer at all, and an approved item's own history (what was proposed, what
     * the owner changed, when it actually happened) lived only in a file nobody could diff.
     *
     * It costs almost nothing to track, which is why the ledger objection does not reach it: an approval is one
     * small file, written a handful of times across its whole life (proposed → approved → done, with
     * `finishedAt`/`result` stamped at the end), and it is KEPT afterwards rather than consumed, so tracking
     * yields a durable record instead of the add/delete churn a queue would produce. Nothing in one is a
     * credential: a platform, a target, the words, a description of what will be done, all of it meant to be
     * read by the owner anyway. */
    { path: ".intentic/config/approvals/", invalidates: ["approvals"], portability: "carry", versioned: true, authored: true },
    // ---- declared by the extension that renders them (contributes.files), not here ----
    // The path is the DAEMON's (automations-store writes both), the query keys are the intentic.automations
    // extension's. It declares them in its own manifest and the browser unions the two lists, so uninstalling
    // the extension takes its invalidations with it instead of leaving a rule for a view that no longer exists.
    {
        path: ".intentic/config/automations.json",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files, `automations` is its query key, not core's.",
        portability: "carry",
        versioned: true,
    },
    /* The run history, keyed by automation id, the LEDGER half of what automations.json used to be, and split
     * out of it for the one reason this table's `versioned` note already gives: a tracked file must be worth
     * reviewing. A scheduled automation records a run every time it fires, so every fire dirtied the manifest
     * the owner reviews, and the run records went into `git log` with it, timestamps and conversation ids
     * committed beside the prompt they belong to, burying an actual edit to the automation's config under
     * machine noise. Config is now the only thing in the tracked file, and a fire touches nothing tracked.
     *
     * It is `carry` for the same reason the workflow ledger is: a run history is about the automation, not about
     * the machine, and an export that dropped it would arrive claiming every automation had never run.
     *
     * Its invalidation is the extension's, exactly like the manifest above, and it has to be DECLARED there
     * rather than inherited, because the row renders its run history from this file now: without its own entry
     * a completed run would stop refreshing the view the moment it stopped living in automations.json. */
    {
        path: ".intentic/records/automation-runs.json",
        invalidates: [],
        why: "Declared by the intentic.automations extension's contributes.files, `automations` is its query key, not core's.",
        portability: "carry",
    },
    {
        path: ".intentic/records/approvals/",
        invalidates: [],
        why: "Declared by the intentic.approvals extension's contributes.files (the page that lists held wakes), `automation-approvals` is its query key, not core's.",
        portability: "carry",
    },
    /* The bug-report inbox, one file per fingerprint, written by the daemon's issues-store as reports arrive
     * from the owner's own sites and apps, and rendered by the intentic.issues extension. Its invalidation is
     * the extension's own (`issues`), declared in that manifest, the automations shape exactly.
     *
     * `carry` rather than `local`: an issue is a fact about the PRODUCT, not about this container. A workspace
     * exported and restored elsewhere that arrived claiming nothing had ever crashed would have thrown away
     * the one record that says which bug is worth fixing first, and the counts are the whole of that record.
     *
     * NOT `versioned`, and the approvals entry is the contrast worth reading: an approval is authored, reviewable
     * and acts under the owner's name, so it earns a diff. An issue is machine-recorded telemetry whose count
     * moves on every crash: tracking it would put a commit's worth of churn in `git log` per bad afternoon,
     * and nothing in it is a decision anybody made. */
    {
        path: ".intentic/records/issues/",
        invalidates: [],
        why: "Declared by the intentic.issues extension's contributes.files, `issues` is its query key, not core's.",
        portability: "carry",
    },
    /* The maintenance ledger and probe evidence, written by the daemon's chores-store and rendered by the
     * intentic.maintenance extension, the automations shape exactly: the path is the daemon's, the query keys
     * (`maintenance-report`, `maintenance-runs`) are the extension's own contributes.files. Point-in-time
     * evidence about this workspace, so `carry` like the run ledgers: an export that dropped it would arrive
     * claiming no chore had ever been checked. */
    {
        path: ".intentic/records/chores/",
        invalidates: [],
        why: "Declared by the intentic.maintenance extension's contributes.files, `maintenance-report`/`maintenance-runs` are its query keys, not core's.",
        portability: "carry",
    },
    /* The documentation STAGING tree (documentation extension's paths.ts): generation writes here, the owner
     * reads and approves here, publishing copies into the repo. `authored` is the whole nature of the entry,
     * these are draft READMEs, approvals-shaped in every way that matters, and "find the staged page about X" is
     * as ordinary a search as finding a post draft. */
    {
        path: ".intentic/config/docs/",
        invalidates: [],
        why: "Declared by the intentic.documentation extension's contributes.files, `documentation`/`documentation-runs` are its query keys, not core's.",
        portability: "carry",
        authored: true,
        outsideWriter: "the intentic.documentation extension's staging writes (its paths.ts)",
    },
    /* The workflow designs and their run ledger became CORE keys the day runs got cards on the fleet board and
     * a mode of the chat panel (web's useWorkflowRuns): those surfaces exist whether or not the workflows
     * extension is enabled, so their freshness cannot ride an extension's contributes.files, an owner turning
     * the extension off would have frozen the board's run cards mid-run. This push is the ONLY live feed the
     * run surfaces have: the scheduler writes the ledger several times per step and nothing polls for it.
     * The runs file invalidates `workflows` too, because GET /workflows embeds each design's runs
     * (WorkflowSummary), a settled step changes that answer as surely as an edited design does. */
    { path: ".intentic/config/workflows.json", invalidates: ["workflows"], portability: "carry", versioned: true },
    { path: ".intentic/records/workflow-runs.json", invalidates: ["workflows", "workflow-runs"], portability: "carry" },
    /* The SAVED loops, which are a manifest and so the opposite of the ledger below them: a handful of entries
     * a person authors, read by two surfaces at once, the workflows page that owns them, and every chat
     * composer's loop picker. Those two are in different windows as often as not (a popped-out chat is its own
     * window), so an edit made on the page has to reach a picker nobody is going to think to reopen. A CORE key
     * rather than the workflows extension's, for the reason the workflow designs beside it are: the composer
     * lists saved loops whether or not that extension is switched on. */
    { path: ".intentic/config/loop-designs.json", invalidates: ["loop-designs"], portability: "carry", versioned: true },
    {
        path: ".intentic/records/loops.json",
        invalidates: [],
        why: "Ralph loops and their iteration history. Nothing observes it: where a RUNNING loop stands rides on the fleet roster (AgentSummary.loop), which the /events stream already pushes about once a second, and a second source invalidating on this file could only ever disagree with the card beside it. The iteration list of an ENDED loop is an on-demand read, nothing renders it until someone opens it (web's useLoops, which holds no query for exactly this reason).",
        portability: "carry",
    },

    /* ---- reached by no query, for reasons that are not oversights ----
     *
     * This channel's currency is a QUERY KEY, and invalidation only reaches a query something is observing.
     * Both entries below are outside that by design, so an empty set is the honest record, naming a key no
     * query uses would put the drift this table exists to remove straight back into it. Each says which
     * constraint would have to move first, so the next reader doesn't re-derive it. */
    {
        path: ".intentic/records/webchat-installs.json",
        invalidates: [],
        why: "Which origins have loaded a Front Desk's widget, written on a 30s flush timer while a customer's site serves page views. The install panel that renders it fetches on open and polls itself while it is on screen, which is the whole window in which the answer changes for anyone. Pushing instead would bill every connected browser a refetch per flush, for a panel almost nobody has open.",
        portability: "carry",
    },
    {
        path: ".intentic/records/issue-installs.json",
        invalidates: [],
        why: "The same probe for the bug reporter's script, on the same flush timer and read by the same kind of panel, so it is outside the push path for the same reason the Front Desk's is.",
        portability: "carry",
    },
    {
        path: ".intentic/records/thread-sessions.json",
        invalidates: [],
        why: "Thread bookkeeping (an inbound thread, a Front Desk visitor, a Discord or Slack channel, → sandbox conversation + provider session), written on EVERY inbound message. Nothing in the browser reads it: what a thread produces is a conversation, and the fleet board already learns about that from the agent registry's own push. Naming a key here would bill every connected browser a refetch per inbound message, the request storm this table's own note warns about, to refresh nothing it can see.",
        portability: "carry",
    },
    /* SPLIT, so that "what an extension is configured to do" and "the token it does it with" stop being one file.
     *
     * This entry used to be `secret` and untracked, classed by what a value COULD hold: values are a primitive
     * union an extension chooses the meaning of, and "an API key for the service I talk to" is squarely within
     * it. That classification was honest about the risk and wrong about the file, it meant an extension's whole
     * configuration was unreviewable because one of its keys might be a credential, AND the credential was in
     * there anyway, in a file the workspace API does not lock. A turn could simply read it.
     *
     * A descriptor already says which keys those are (`contributes.settings[].secret`), so the values it names
     * now live in the vault off /work and this file keeps the rest, the capability manifest's split, applied to
     * the same problem one table over (extensions/extension-settings.ts holds it, and the reasoning). Reads
     * rehydrate, so no caller changed.
     *
     * What the split earns: `carry`, because what is left is an extension's configuration and a bundle should
     * arrive with it; and `versioned`, because turning an extension's behaviour on is a decision, and the file
     * that records it can now be read without reading anybody's token. The boot sweep is what keeps that true of
     * a file the agent can also edit, see vaultExtensionSettingSecrets.
     *
     * NO `note`, and the split is why: a note is printed by the import report beside a SKIPPED entry, so an entry
     * that carries can never show one. "Re-enter the credentials" is now the vault's instruction to give, and the
     * vault is under `.intentic/auth/`, which is skipped, and says so there. */
    {
        path: ".intentic/config/extension-settings.json",
        invalidates: [],
        why: "Held in a module-level shallowRef store per extension (web's extensionSettingsStore) with no query observer, and deliberately so: api.settings.get must answer SYNCHRONOUSLY from an extension's first activate() line, and the store outlives every component scope. A module-level QueryObserver is the one shape that would make invalidation refetch, and this app already ruled it out, it detaches on the queryClient.clear() at logout (see useSandbox's sandbox-list mirror). So a remote member's setting edit reaches this browser on its next load, not live.",
        portability: "carry",
        versioned: true,
    },
    /* Unlike the settings file above it, the on/off switch IS observed by a query, the Extensions tab's list,
     * which carries each row's switch position, so a flip made elsewhere (another member, the agent writing the
     * file) shows up here live. It does not re-run the host: activating or retiring an extension is the loader's
     * reconcile, which the tab's own toggle triggers, so a remote flip takes effect on this browser's next load. */
    {
        path: ".intentic/config/extension-enablement.json",
        invalidates: ["extensions"],
        portability: "carry",
        versioned: true,
    },
    /* Workspace extensions: one directory per extension, consumed straight from the workspace, no clone, no
     * install moment. Written like approvals, by the agent's own file tools (which is the point: an agent authors
     * an extension and it is live for the daemon and every session at once, since .intentic is shared), so this
     * push is what makes one appearing or changing show up on the Extensions tab while the owner watches.
     * `authored` for the same reason as approvals: this is source the agent wrote and will be asked to find,
     * unlike `.intentic/extensions/` below, which is CLONES of source that lives elsewhere.
     *
     * `versioned` FOR THAT SAME REASON, which is the whole argument. Every other load path an extension can take
     * is already reviewable by construction: a git-installed one is a sha in `capabilities.json` that an owner
     * approved, a baked one shipped in the image. This one is neither, it is code that appears because an agent
     * wrote a file, runs in the app on the owner's session, may register a rail tile, and may serve HTTP from a
     * node process with the workspace under `node:fs` and whatever `permissions.daemon` names. Untracked, the
     * switch that turns it on was in `git log` (extension-enablement.json, below) while the thing being switched
     * on was not: a commit could record enabling something nobody else could read. It is also the one extension
     * kind with no install moment to review at, so the diff is the only review there is.
     *
     * Not a ledger and not bulk: a handful of small authored files per extension, written when someone edits them.
     * The daemon restarts the backend host on a change here, so an edit is already a consequential event, this
     * makes it a legible one. */
    { path: ".intentic/config/workspace-extensions/", invalidates: ["extensions"], portability: "carry", versioned: true, authored: true },
    /* What the registry comparison found per installed extension (update available / advisory / post-update
     * health), written by the periodic check and by the update/revert transactions, pushed to the tab because
     * an advisory that auto-disabled something must not wait for a reload to be seen. */
    { path: ".intentic/records/extension-updates.json", invalidates: ["extensions"], portability: "carry" },
    /* The owner's per-extension update posture (notify / agent / auto, and the advisory opt-out). Carried:
     * it is a decision about the extension, not about this machine. */
    { path: ".intentic/config/extension-update-policy.json", invalidates: ["extensions"], portability: "carry", versioned: true },
    /* Carried, because the evidence is about the extension rather than about the machine: an export that dropped
     * it would arrive claiming every permission was unused, which is worse than arriving with no figures at all. */
    {
        path: ".intentic/records/extension-usage.json",
        invalidates: [],
        why: "Which of the routes each extension DECLARED it has actually called, the evidence behind the permissions list on its row. The one entry here whose empty set is a RATE decision rather than an architectural one: every browser with the app open reports its batch on a timer, so wiring this to the `extensions` query would refetch the whole list every few seconds for a figure nobody is watching change. The tab reads it when it loads, which is when anyone is reading it.",
        portability: "carry",
    },
    /* THE ONE ENTRY WHERE "HOLDS NO CREDENTIAL" IS TRUE AND `versioned` IS STILL WRONG, which is worth stating
     * because it looks like the two above it: an email and a role per row, nothing to vault, and "who may drive
     * this sandbox" is as consequential a fact as any this table tracks.
     *
     * It stays out for two reasons that are not about secrecy. It is a MIRROR, the platform's invite records are
     * the grant, this is the copy the enforcer keeps so a grant it never received is never honoured, and a change
     * here is the two disagreeing rather than anyone deciding something. Review of the decision already exists,
     * on the Access tab, against the record that is authoritative. And tracking it would mean reclassifying it
     * `carry` to satisfy the guard, which is the one thing it must never be: an access list that travelled would
     * let a source sandbox hand itself the target's ownership. Widening the guard for this single entry is the
     * worse trade, it protects every `identity` entry, and most of those ARE credentials. */
    {
        path: ".intentic/identity/members.json",
        invalidates: [],
        why: "Not this view's source at all: SandboxAccess renders the PLATFORM's invite records (apiClient.invite.list), and this file is the daemon's ENFORCED copy, written first so a grant the enforcer never got is never recorded, then never read back. A change here means the two disagreed, which the write order makes fail-closed rather than stale.",
        portability: "identity",
        note: "Re-invite collaborators from the Access tab, a grant is the platform's record, and the target enforces its own copy.",
    },

    // ---- daemon-owned, nothing derives from watching them ----
    /* Keep credentials and conversation state in disjoint top-level trees. Provider homes are intentionally
     * classified as a single secret unit: several CLIs mix OAuth, config, and provider-native thread metadata,
     * and no generic export can safely distinguish those files. The broad root also makes a newly-added provider
     * secret by construction instead of relying on another hand-maintained provider-name list.
     *
     * IT IS NO LONGER ONLY THE AI LOGINS. Both credential splits put their vault here, `capability-secrets.json`
     * and `extension-secrets.json`, sited beside the provider homes precisely because this tree is already
     * outside the file routes, the workspace walk and the search index (composition.ts sites them, and the two
     * stores argue why). So this is now the ONE entry a secret-less bundle leaves behind, and its note is
     * therefore the only place the owner is told what to re-enter: the manifests that name those connections
     * travel, and would otherwise arrive looking complete. */
    {
        path: ".intentic/secrets/auth/",
        invalidates: [],
        why: "AI-provider credentials and runtime homes, plus the capability and extension-settings secret vaults; each account is rendered through owner-gated provider routes.",
        portability: "secret",
        note: "Sign the agent's AI accounts in again on the Agent tab, then re-enter each connection's credential on Capabilities and each extension's secret settings on Extensions, both arrived listed but unauthenticated.",
    },
    /* Agent session transcripts, rewritten on every streamed token: nothing renders them off disk, so nothing
     * under here is watched. The exclusion is a DESCENT filter, which is what makes it cheap: the watcher never
     * walks `projects` and its per-slug subtrees at all. Measured on the live workspace, descending would add
     * +119 watched directories against ~593 (a fifth more), with 314 continuously-rewritten transcripts inside
     * the newly-watched set. If a surface here ever needs to be live, weigh that 20% against a poll first. */
    {
        path: ".intentic/records/sessions/claude/",
        invalidates: [],
        why: "Agent session transcripts; nothing derives from watching them, and descending into them would cost a fifth of the watcher.",
        portability: "carry",
    },
    {
        path: ".intentic/records/artifacts/",
        invalidates: [],
        why: "Durable outputs owned by conversations and extension runs: attachments, browser captures, generated images, acceptance reports, workflow step reports, voice transcripts, and loop ledgers.",
        portability: "carry",
    },
    {
        path: ".intentic/local/cache/",
        invalidates: [],
        why: "Rebuildable indexes and caches, the iq index and its vector sidecar, the whisper model, fileq's derived/ markdown shadows of binary files; ignored by the watcher and recreated from carried workspace content.",
        portability: "derived",
    },
    /* Connector and extension scratch, one directory per extension under runtime/extensions/<id>
     * (extensionRuntimeDir below, the ONLY way an extension names a home here, so a new one lands under its
     * own id by construction instead of minting a file at the .intentic root). Resume watermarks, cached
     * hour-tokens, gateway discovery state: all of it either expires or re-establishes itself, and classifying
     * the root once is what keeps a token an extension caches tomorrow out of bundles without a second edit. */
    {
        path: ".intentic/local/runtime/",
        invalidates: [],
        why: "Extension runtime scratch (watermarks, cached short-lived tokens); nothing renders it and gateways re-derive it.",
        portability: "derived",
        outsideWriter: "extensions, through extensionRuntimeDir below",
    },
    {
        path: ".intentic/local/tmp/",
        invalidates: [],
        why: "Scratch that agents and tools leave behind (build logs, demo checkouts); nothing reads it after the turn that wrote it. The state janitor empties it at boot.",
        portability: "derived",
    },
    /* Not written by the daemon at all: pnpm auto-creates its content-addressable store at the project's
     * mountpoint, and `.intentic` is its own mount in an isolated turn, so an install run from under it mints
     * this. Declared anyway, because the table's job is to say what everything under `.intentic` IS: hardlink
     * sources a fresh install rebuilds, which an export must not ship (it reached 1.3 GB on the workspace this
     * entry was written against). */
    {
        path: ".intentic/local/.pnpm-store/",
        invalidates: [],
        why: "pnpm's content-addressable store, auto-created by installs run from under .intentic; the next install rebuilds it.",
        portability: "derived",
        outsideWriter: "pnpm itself, when an install runs from under .intentic",
    },
    {
        path: ".intentic/local/newest-run.json",
        invalidates: [],
        why: "The newest daemon version that ever ran this workspace (store/newest-run.ts), a downgrade tripwire, about THIS sandbox the way rule-firings is.",
        portability: "derived",
        note: "The target stamps its own daemon version on first boot.",
    },
    {
        path: ".intentic/records/verify.json",
        invalidates: [],
        why: "The dependency verifier's verdict memory; nothing renders it directly, outcomes reach the owner as activity entries and workspace events.",
        portability: "carry",
    },
    {
        path: ".intentic/local/verify/",
        invalidates: [],
        why: "A running check's wrapper artifacts (log + exit status), read once by the daemon when the panel finishes.",
        portability: "derived",
    },
    {
        path: ".intentic/secrets/ci.json",
        invalidates: [],
        why: "Webhook secret + conclusion memory; the Pipelines view reads it through /ci/runs, not off disk.",
        portability: "secret",
        note: "Re-add the CI webhook on the Pipelines view, its secret is per-sandbox.",
    },
    /* THE ONE ENTRY THAT OPTS OUT OF THE BACKUP, and the reason the flag exists rather than the rule simply
     * reading `portability !== "derived"`. It is `identity` like the three below it, so the derived answer would
     * copy it down with them, but where those are a name, a workspace id and a role per row, these are tokens
     * that AUTHENTICATE against this sandbox from outside it. Hashed, which lowers the stakes and does not
     * settle them: the point of a backup is to be readable after the thing it backs up is gone, and a file whose
     * only purpose is to admit callers has no business sitting in one. Nothing is lost by leaving it out, the
     * entry's own note already says the tokens must be re-minted on any new sandbox, so a copy could never have
     * been restored anyway. */
    {
        path: ".intentic/identity/control-tokens.json",
        invalidates: [],
        why: "Hashed control tokens (the ACP editor bridge, and anything else driving this sandbox from outside), listed on demand by the owner.",
        portability: "identity",
        backup: false,
        note: "Mint fresh control tokens, the old ones authenticate against the source sandbox.",
    },
    {
        path: ".intentic/identity/owner.json",
        invalidates: [],
        why: "Bound once on first use; a change here means the sandbox was re-owned, which re-authenticates anyway.",
        portability: "identity",
    },
    {
        path: ".intentic/identity/workspace.json",
        invalidates: [],
        why: "The workspace identity, read from the /events hello frame rather than as a file.",
        portability: "identity",
    },
    {
        path: ".intentic/config/templates.json",
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
        path: ".intentic/local/browser/",
        invalidates: [],
        why: "Browser-login profiles: Chromium rewrites these constantly. Descent-ignored by the watcher outright.",
        portability: "derived",
        note: "Log the agent's browser back into any site it needs, profiles do not travel.",
    },
    {
        path: ".intentic/local/extensions/",
        invalidates: [],
        why: "Extension checkouts, whole git clones. The `extensions` query is driven by the capability manifest above, not by their contents.",
        portability: "derived",
        note: "Extensions re-clone from the capability manifest on the target's next reconcile.",
    },
    { path: ".intentic/records/plugins/", invalidates: [], why: "Agent plugin dirs, read by the SDK's loader each turn.", portability: "carry" },
    /* THE SKILLS THE OWNER WROTE THEMSELVES, one directory per skill, the source of truth the reconciler copies
     * into `.agents/skills` for the ones currently switched on (settings.json's `skills` list). It is here rather
     * than in the loaded folder for the reason the plugin dirs are: that tree holds only what is currently ON,
     * and a skill switched off has to keep its text somewhere the loaders will not read it from.
     *
     * `versioned`, like the rest of the config slice: a skill changes how the agent behaves, so it earns a diff
     * in the Changes review and a line in `git log` the same way a rule or a persona does. `carry` for the same
     * reason, it is text the owner wrote, with no credential in it and nothing about this machine. */
    { path: ".intentic/config/skills/", invalidates: ["skills"], portability: "carry", versioned: true },
    /* ONE FOLDER PER PERSONA, what a session wearing that card is told, and the skills and tools only it gets.
     * Laid out as a Claude Code plugin (`.claude-plugin/plugin.json`, `skills/`, `agents/`, `commands/`,
     * `hooks/`, `.mcp.json`) so the runtime's own loader reads it and this daemon parses none of it, exactly as
     * the plugin checkouts above are read (personas/persona-kit.ts).
     *
     * A SECOND ENTRY BESIDE `personas.json` RATHER THAN A FIELD INSIDE IT, because the two are different kinds
     * of thing to review. The card is a name, some ids and some switches, a few lines that diff cleanly. This
     * is prose and files: a system prompt, a skill, a subagent. Folding a 20k prompt into the JSON would make
     * every persona edit an unreadable diff and put text somebody wrote inside a record nobody writes by hand.
     *
     * `versioned` and `carry` for the same reasons the card and the skills above are: it changes how the agent
     * behaves, it holds no credential, and it belongs in a pull request, which is also what makes it
     * searchable, since every versioned entry already is. */
    { path: ".intentic/config/personas/", invalidates: ["personas"], portability: "carry", versioned: true },
] as const satisfies readonly WorkspaceStateFile[];

export const WORKSPACE_STATE_FILES: readonly WorkspaceStateFile[] = STATE_FILES;

/* The entries the root repo tracks, workspace-root-relative and in declaration order, what history.ts turns
 * into the negations that carve them back out of the wholesale `.intentic` exclusion.
 *
 * Derived rather than written down beside the exclude rule, for the reason this whole file exists: the git rule
 * lives in the daemon and the classification lives here, and a second hand-kept copy of "which config is
 * reviewable" is a copy that goes stale the first time someone adds a store. Marking an entry `versioned` is now
 * the entire change, the exclude list follows on the next boot, in both places it is written. */
export const VERSIONED_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.versioned).map((file) => file.path);

/* The `.intentic` slice a workspace SEARCH may surface: configuration a person reviews (`versioned`) plus the
 * authored-content dirs (`authored`), approvals, staged docs, workspace extensions. Everything else under
 * `.intentic` is machine state, and the search engine (iq's floor) denies it BY DEFAULT off this list, the
 * same default-deny the portability classes are built on and for the same reason: a deny list is a list a new
 * ledger is forgotten from, and the forgetting is silent, it ranked loop iteration history and cloned
 * third-party extension source against the user's own code for months before this derivation existed.
 *
 * WHAT THE CREDENTIAL SPLITS MOVED ACROSS THIS LINE, since the note that used to sit here said the opposite and
 * was worth replacing rather than deleting. `capabilities.json` was `secret` and unversioned, and the sentence
 * celebrated that the index therefore stopped copying capability tokens into search text. It is `versioned` now
 * and searchable, and the guarantee is unchanged, because the tokens are not in the file any more. The floor
 * moved from "keep the index away from the file that holds credentials" to "the file holds none", which is the
 * stronger of the two: it also holds for the shell, which never consulted this list at all. `auth/`, where those
 * values went, both vaults included, is still denied, and is the entry that was doing the real work all along. */
export const SEARCHABLE_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.versioned || file.authored).map(
    (file) => file.path,
);

/* WHAT KIND OF THING THIS IS, in the one word a person browsing the state dir would use, and the axis the
 * DIRECTORY LAYOUT is built on, so the folder you open explains itself before you read a table about it.
 *
 * It is DERIVED, and that is the whole reason it can be trusted. Forty-nine entries already answer three
 * questions between them (is it reviewed, is it authored, does it travel), and those answers turn out to nest
 * perfectly rather than cut across each other: every `versioned` entry is `carry`, every `authored` entry is
 * `carry`, and nothing is both a credential and a thing a person edits. A nested set of answers is exactly what
 * a directory tree can express, which is why five folders can carry rules that used to take five hand-kept path
 * lists, the git exclude, the search allow-list, the sync ignore, the watcher skip, the export bundle.
 *
 * Declaring the group on each entry instead would have made it a fourth independent fact to keep in step with
 * the other three, which is the failure this file exists to argue against. Adding a store still means answering
 * the same three questions it always did; the group, the folder it belongs in, and every rule that reads them
 * follow with no further edit. */
export type StateGroup =
    /* Reviewed and reviewable: settings, personas, skills, approvals, staged docs, the environment overlay. Tracked
     * by the root repo, searchable, backed up, and carried into a new sandbox. Two of its members (approvals, staged
     * docs) are authored content rather than configuration, and the folder is still called `config`, the word
     * that makes seventeen of the nineteen instantly clear beats one that makes all nineteen vague. */
    | "config"
    /* What HAPPENED here, run ledgers, approvals, chores, transcripts, artifacts. Machine-written, so untracked
     * and unsearchable, but the owner's history all the same: backed up and carried. */
    | "records"
    /* Rebuildable from something that does travel: caches, indexes, extension checkouts, scratch, the composed
     * overlay, browser profiles. Neither backed up nor carried, and the janitor may delete it. `local` in the
     * sense every other tool uses it, belongs to this machine, is not shared, and losing it costs nothing. */
    | "local"
    /* Who owns this sandbox and who may drive it. Backed up so the owner keeps a copy of their own access, never
     * carried, a list that travelled would let a source sandbox claim the target. */
    | "identity"
    /* Credentials. Never backed up; carried only when the owner opts in at export and the bundle records it. */
    | "secrets";

/* THE FOLDER EACH GROUP LIVES IN.
 *
 * The group name IS the directory name, one vocabulary, not a name and a translation of it. That is what lets
 * the guard in workspace-state.test.ts check the whole layout with one rule ("every entry sits under its own
 * group's folder") rather than trusting forty-nine literals to have been typed correctly, and it is why renaming
 * a folder is an edit here plus the literals the compiler then points at, with nothing able to half-move.
 *
 * WHICH RULES THE LAYOUT ACTUALLY CARRIES, stated plainly because it is fewer than the tidy version of this
 * story. The sync backup collapses to two folder names (BACKUP_IGNORES) and workspace search to one, because
 * "may the owner keep this" and "is this authored text" are exactly what the grouping sorts on. Two others do
 * NOT collapse, and both are worth knowing about before someone tries:
 *   - THE GIT EXCLUDE tracks `versioned`, which is eighteen of `config`'s nineteen. The exception is the staged
 *     docs tree: searchable, deliberately untracked (publishing copies those pages into the repo, so tracking
 *     the staging copy too would double every one of them). A `config/` prefix would quietly start tracking it.
 *   - THE WATCHER skips what churns, which is most of `local` but not all of it: the composed overlay and the
 *     rule-firing stamps are `derived` and therefore `local`, and both still feed a view. A `local/` prefix
 *     would stop the environment page refreshing when the overlay is recomposed.
 * Both stay derived from the flags instead, which costs a longer generated list and no correctness. The folders
 * are the layout; the flags are still the authority. */
export const STATE_GROUP_DIR: Readonly<Record<StateGroup, string>> = {
    config: `${STATE_DIR}/config`,
    records: `${STATE_DIR}/records`,
    local: `${STATE_DIR}/local`,
    identity: `${STATE_DIR}/identity`,
    secrets: `${STATE_DIR}/secrets`,
};

// Every group, derived off the folder map so the two can never disagree about how many there are. Declaration
// order is the order a person should read them in: what you wrote, what happened, what can be thrown away, who
// owns this, and the keys.
export const STATE_GROUPS = Object.keys(STATE_GROUP_DIR) as readonly StateGroup[];

/* The group each entry falls in. Ordered most-specific-first: a credential is a credential whatever else it is,
 * and only once those are out of the way does "did a person write this" separate the two `carry` groups. */
export const stateGroupOf = (file: WorkspaceStateFile): StateGroup => {
    switch (file.portability) {
        case "secret":
            return "secrets";
        case "identity":
            return "identity";
        case "derived":
            return "local";
        case "carry":
            return file.versioned === true || file.authored === true ? "config" : "records";
    }
};

// The entries of one group, workspace-root-relative and in declaration order, what each rule that used to keep
// its own path list now asks for instead.
export const stateGroupPaths = (group: StateGroup): readonly string[] =>
    WORKSPACE_STATE_FILES.filter((file) => stateGroupOf(file) === group).map((file) => file.path);

/* WHAT AN ISOLATED TURN SHARES LIVE WITH THE MAIN TREE, and what is its own. The state dir is split along ONE
 * line, and it is the line git already draws: what the root repo TRACKS (`versioned`) is the worktree's own
 * checkout, edited on the agent's branch, reviewed in its diff and landed like code; everything git does NOT
 * track is bound in from the main tree (agents/isolation.ts), one directory for every conversation, because a
 * transcript, a ledger, a browser capture or a staged doc written into a per-worktree copy is simply lost.
 *
 * The two used to be one bind over the whole dir, with the tracked slice sparse-excluded from every worktree to
 * keep git from writing through it. That put the ONE thing a person reviews outside the one door that records
 * provenance: an agent's settings edit, approval, environment fragment or skill went straight into the owner's
 * working tree, unattributed, with no branch commit and nothing for a land to conflict on. Binding by group
 * ends both problems at once, nothing tracked sits behind a bind, so nothing git does in a worktree can reach
 * the live tree, and the sparse machinery has nothing left to guard.
 *
 * WHOLE GROUP DIRS WHERE THE WHOLE GROUP IS UNTRACKED (records, local, identity, secrets), not their entries: a
 * file an extension writes under `records/` without declaring it must still land in the shared tree, and a
 * per-entry bind would strand it in the worktree. Only a group that MIXES tracked and untracked entries (config,
 * for the staged docs tree) is bound entry by entry. Derived, so a store added tomorrow is placed by its
 * `versioned` flag alone, and the layout guard in workspace-state.test.ts pins that no tracked entry can ever
 * sit under a shared prefix. Trailing slash kept on every entry, as the table spells directories. */
export const SHARED_STATE_PATHS: readonly string[] = STATE_GROUPS.flatMap((group) => {
    const files = WORKSPACE_STATE_FILES.filter((file) => stateGroupOf(file) === group);
    return files.some((file) => file.versioned === true)
        ? files.filter((file) => file.versioned !== true).map((file) => file.path)
        : [`${STATE_GROUP_DIR[group]}/`];
});

/* THE SLICE DESKTOP-SYNC COPIES DOWN, ordinary state and the records that bind this sandbox to its owner,
 * minus anything that opted out (see `backup` on the interface).
 *
 * The sync used to ignore `.intentic` WHOLE, which is the same conflation the `backup` flag exists to undo: the
 * dir holds credentials, so the dir was excluded, so a sandbox going away also took every persona, skill,
 * automation, draft and transcript the owner had. This is the list that makes the owner's machine an actual
 * backup instead of a copy of the source tree only.
 *
 * It is deliberately NOT the same as the export bundle. A bundle asks what may be reconstituted somewhere else;
 * this asks what the owner may keep. `ownership` is the entries where those differ, and it is in here. */
export const BACKED_UP_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter(
    (file) => file.backup !== false && (file.portability === "carry" || file.portability === "identity"),
).map((file) => file.path);

/* Its complement, which is what a sync ignore list actually needs: everything under the state dir that must NOT
 * come down. Derived from the same predicate rather than listed, so a store added tomorrow is excluded until its
 * class says otherwise, the same default-deny the search floor and the portability classes are built on. */
export const UNBACKED_STATE_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => !BACKED_UP_STATE_PATHS.includes(file.path)).map(
    (file) => file.path,
);

/* THE ONE WAY AN EXTENSION NAMES ITS SCRATCH HOME, `.intentic/runtime/extensions/<id>`, workspace-relative
 * and forward-slash so the browser bundle can hold it too; callers join it onto whatever root is in force.
 *
 * It exists for the reason statePath does one table over: before it, every gateway spelled the layout itself
 * and one extension (deployments) simply didn't, minting `komodo.json` at the `.intentic` root where nothing
 * classified it. An extension that composes through this helper cannot land outside its own directory, so the
 * runtime/ entry's `derived` covers whatever it writes tomorrow. Extension ids are validated slugs already;
 * the replace is defence in depth against a path ever being built from something else. */
export const extensionRuntimeDir = (extension: string): string =>
    `${STATE_GROUP_DIR.local}/runtime/extensions/${extension.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;

/* The manifests whose problems the unreadable-manifest notice SHOWS, the handful a person hand-edits, and the
 * one fact that decides it is already in the table above.
 *
 * Every store reads through the same `jsonFile`, so every store reports what it could not make sense of, and for
 * a long time the notice showed all of them. That is wrong twice over. Its advice, fix the file and this clears
 * on its own, is addressed to somebody holding an editor, which is true of `settings.json` and false of a
 * daemon-written LEDGER nobody opens: a run history that stopped matching a schema the build tightened is not a
 * mistake the owner made, and the card asked them to repair sixty kilobytes of machine JSON by hand. Worse, a
 * file that reports into the notice without feeding the notice's QUERY leaves a complaint no write can refresh,
 * so it sits on screen until the daemon restarts, which is exactly how the workflow ledger's entry became
 * permanent furniture.
 *
 * Both follow from one rule, which is why this derives rather than lists: a file's problems are shown IFF a write
 * to that file refreshes the notice. Declaring `manifests` in `invalidates` is the entire opt-in, so the edit
 * that puts a file on the card is the same edit that keeps it current, and neither can be done without the
 * other. A ledger that breaks still falls back and still sets its unreadable bytes aside on the next write
 * (store/json-file.ts), it just stops asking the owner to fix it. */
export const REPORTED_MANIFEST_PATHS: readonly string[] = WORKSPACE_STATE_FILES.filter((file) => file.invalidates.includes("manifests")).map(
    (file) => file.path,
);

// Accepts either separator, like isLockedWorkspacePath below: the daemon holds these as platform paths and makes
// them relative at the last moment, and normalizing at each call site is the one that eventually gets forgotten.
export const isReportedManifest = (relPath: string): boolean => REPORTED_MANIFEST_PATHS.includes(relPath.replaceAll("\\", "/"));

/* THE DAEMON'S OWN CONTROL PLANE, the entries directly under the workspace root's `.intentic/` that the file
 * API refuses to read, write, move or delete for anyone, the owner included (workspace/workspace-files.ts holds
 * the enforcement and the full reasoning for each name).
 *
 * The list lives HERE, in the package both sides import, because the browser has to draw the same rule the
 * daemon enforces. It didn't, and the gap was a small piece of theatre: the explorer listed `capabilities.json`
 * like any other file, opening it flashed a tab, the read came back with nothing there, and the tab closed
 * itself, a refusal acted out as a glitch. A file the app will not open should say so before it is clicked,
 * which takes a rule the explorer can consult, not a status code it can only react to.
 *
 * Naming these to the browser gives nothing away that the tree did not already publish, it listed them, sizes
 * and all. What stays behind the guard is the only thing that ever mattered: the bytes. */
/* GROUP-RELATIVE NOW, and the one rule the regrouping did NOT simplify, worth saying because every other rule
 * over this tree collapsed to a prefix and this one could not. What the file API refuses to open cuts ACROSS the
 * groups: the capability manifest is `config`, the transcripts are `records`, the browser profiles are `local`,
 * and all of `identity` and `secrets` is in. That is not an accident of the grouping, it is a different question
 *, "would showing the bytes hand someone something" rather than "what kind of thing is this", so it keeps an
 * explicit list, just one that now names the folder each entry lives in. */
const LOCKED_STATE_ENTRIES: ReadonlySet<string> = new Set([
    "identity/owner.json",
    "identity/members.json",
    "identity/control-tokens.json",
    "config/capabilities.json",
    "secrets/ci.json",
    "secrets/auth",
    "records/sessions",
    "local/browser",
    /* The provider CLI's own home, which this table does not declare and so has no group to move into, it is
     * written by the agent's runtime rather than by any daemon store. It stays at the state dir's root, and the
     * two-segment match below still reaches it because a bare name joins to itself. Locked for the reason the
     * credential entries are: it holds a live session for whatever the agent is signed into. */
    "claude.json",
]);

/* Whether a workspace-root-relative path lands in that control plane, and so is shown locked rather than
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
    if (segments[0] !== STATE_DIR) {
        return false;
    }
    // Two segments, which covers both spellings in the set above: a grouped entry (`secrets/auth`) matches as
    // written, and a bare root entry (`claude.json`) joins to itself because there is no second segment to add.
    return LOCKED_STATE_ENTRIES.has(segments.slice(1, 3).join("/"));
};

/* THE LOCKED ENTRIES THE ROOT REPO TRACKS, refused by the file API, and diffable anyway.
 *
 * `capabilities.json` is the only one today and the whole reason this exists. Both of its rules are right on
 * their own: it is `versioned`, because connecting this sandbox to a deployment orchestrator is the largest
 * change anyone makes to what it can DO and that belongs in review; and it is locked, because a member who
 * could PUT one through the generic file API would be granting themselves a capability the owner never
 * approved. The lock was always about that WRITE, its credentials live in the vault, not in the file.
 *
 * Together, though, the second silently cancelled the first. The Changes panel listed the file (git tracks it,
 * so `git status` reports it), and clicking the row asked a diff route that refuses every control-plane path,
 * a 404 on the one surface `versioned` exists to produce. The bytes were already in `git log`, in every clone
 * of the root repo and in the workspace search; only the review was missing.
 *
 * So the review surfaces ask THIS instead of the flat lock, and it derives from the same flag rather than
 * naming the file, so marking another locked entry `versioned` cannot reproduce the contradiction. Every other
 * surface, read, write, move, delete, publish, still asks `isLockedWorkspacePath` and still refuses.
 *
 * Accepts either slash, like the rule above it. */
export const isReviewableLockedPath = (relPath: string): boolean => {
    const rel = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
    return isLockedWorkspacePath(rel) && VERSIONED_STATE_PATHS.some((path) => (path.endsWith("/") ? rel.startsWith(path) : rel === path));
};

/* Every path this table declares, as a type. `as const` above is what makes it one, and it is what finally makes
 * the first sentence of this file's header TRUE rather than aspirational.
 *
 * "The daemon builds its store paths from `path`" was the design; the code did not. `composition.ts` and twenty
 * files beside it spelled the same layout a SECOND way, `join(root, ".intentic", "settings.json")`, with
 * nothing tying the two spellings together. Rename a store's file and this table keeps declaring the old name:
 * no error, no failing test, just a view that quietly stops refreshing, which is the exact failure the table was
 * written to end and the exact way approvals went missing.
 *
 * So the daemon joins through `statePath` (workspace/state-paths.ts), which takes one of THESE and nothing else.
 * A rename is now a compile error at every site that names the file, in both packages, or it is not a rename. */
export type WorkspaceStatePath = (typeof STATE_FILES)[number]["path"];

/* The query keys a batch of changed paths makes stale, deduped and stable. The browser's `/events` handler calls
 * this; keeping it here rather than in the web means the rule is unit-testable without a query client, and the
 * daemon can assert against the same table.
 *
 * `contributed` is what the ACTIVATED extensions declared in `contributes.files`, passed in rather than
 * imported, because which extensions are live is a browser fact this package has no way to know. It is a
 * required argument for the same reason: an added second source that callers may forget is a source that
 * silently does nothing, which is the failure this whole file exists to remove. Extension entries are unioned
 * flat with the core ones, not layered over them: both lists describe the same fact about the same file, and a
 * path can legitimately match one entry in each, a core prefix that invalidates nothing must not veto a
 * narrower extension entry beneath it, or everything under one of the daemon's machine-state prefixes would be
 * unreachable to extensions by construction. */
export const staleQueryKeys = (paths: readonly string[], contributed: readonly FileContribution[]): readonly string[] => [
    ...new Set(
        [...WORKSPACE_STATE_FILES, ...contributed]
            .filter((file) => file.invalidates.length > 0 && paths.some((path) => path.startsWith(file.path)))
            .flatMap((file) => file.invalidates),
    ),
];

/* Every query key any watched file feeds, what a NEW /events connection invalidates wholesale (core's table
 * plus the running extensions'). The file push is these keys' ONLY live feed, and a `workspaceChanged` frame
 * produced while the stream was down is a frame nobody will ever resend, so each key's view would sit stale
 * until the file's NEXT write, indefinitely for anything that settled while the browser was away. Re-asking on
 * connect bounds the damage at one cheap read per key, which is what lets those views go entirely unpolled. */
export const fileBoundQueryKeys = (contributed: readonly FileContribution[]): readonly string[] => [
    ...new Set([...WORKSPACE_STATE_FILES, ...contributed].flatMap((file) => file.invalidates)),
];
