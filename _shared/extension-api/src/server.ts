import type { sandboxContract } from "@intentic/sandbox-contract";
import type { Conversion, Granularity } from "@intentic/sandbox-contract/documents";
import type { ToolEffect } from "@intentic/sandbox-contract/peer-mcp-server";
import type { PasskeyCosign } from "@intentic/sandbox-contract/s2s";
import type { WebhookSignatureScheme } from "@intentic/sandbox-contract/schemas/automations";
import type { MemberTier } from "@intentic/sandbox-contract/schemas/shared";
import type { ContractRouterClient } from "@orpc/contract";
import type { Disposable } from "./disposable.js";
import type {
    ActivityRow,
    CiFeedEvent,
    ExecOptions,
    ExecResult,
    IdentityReach,
    RunSettled,
    SandboxActivity,
    SleepBoot,
    SleepHandler,
    SleepHeardMessage,
} from "./server-reach.js";

// The effect vocabulary the daemon's own tools and every device's tools declare, re-exported so a tool here says what it
// does in the same words.
export type { ToolEffect };

// Backend counterpart to `IntenticApi` (api.ts); a manifest `server` bundle's `activateServer` runs in a node process
// shared by every enabled extension, separate from the daemon. Mediates only the extension's route namespace (mount)
// and its reach into daemon routes (`daemon.*`, gated by `permissions.daemon`).

// The card a tool server was mounted for (`contributes.tools.perCard`): its id, which names the server the agent sees,
// and its settings as the daemon holds them now, secrets included, every value a string. Handed with every call, so a
// switch flipped on the card applies to the next call without anything to invalidate.
export interface ToolCard {
    readonly id: string;
    readonly config: Readonly<Record<string, string>>;
}

// One piece of what a tool answers, as MCP carries it.
export type ToolContent =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string };

// A tool's whole answer. `isError` marks a refusal or a failure the model should read rather than a transport error.
export interface ToolResult {
    readonly content: readonly ToolContent[];
    readonly isError?: boolean;
}

// (2026-11-26) A sandbox browser account the calling turn holds (a browser card, or an identity's own browser): its id,
// which `api.browser.call` names, and the sites it signs in on, the only ones an extension drives its browser on (its
// sign-in and home pages' hosts, widened to the operator's sign-in family: x.com stands for twitter.com too).
export interface ToolGrantAccount {
    readonly id: string;
    readonly kind: "browser" | "identity";
    readonly sites: readonly string[];
}

// (2026-11-26) What the turn that called a tool holds, read by the daemon from that turn's own grants (its role, and the
// reach of the people it is for): never a credential, never more than the turn holds.
export interface ToolCallGrants {
    // The sandbox's signed-in browser accounts, for `api.browser.call`.
    readonly accounts: readonly ToolGrantAccount[];
    // The owner's own browsers (their `webext` cards), for `api.ownerBrowser.call`.
    readonly browsers: readonly string[];
    // The cards of this extension's own kinds the turn holds.
    readonly cards: readonly string[];
}

// What one call is handed beside its arguments.
export interface ToolCallContext {
    // Aborted when the agent's client gives up on the call, or the host's deadline for it passes.
    readonly signal: AbortSignal;
    // The conversation the calling turn belongs to, when it has one.
    readonly conversationId?: string | undefined;
    // (2026-11-26) What the calling turn holds, so a tool can refuse itself ("this turn holds no chatgpt.com account");
    // the daemon refuses anything outside it anyway. Absent where no daemon told it (a test, a daemon before 2.55.0).
    readonly grants?: ToolCallGrants | undefined;
    // (2026-11-26) This call's ticket onto its turn, minted by the daemon for this extension and this call and good only
    // while it runs: what `api.browser.call`, `api.ownerBrowser.call` and `api.jobs.start` hand back. Opaque.
    readonly ticket?: string | undefined;
}

// (2026-11-26) What reaches the calling turn's grants: a tool's call while it runs (its ToolCallContext), or a job it
// started (RunningJob) for as long as the job runs.
export interface TurnStanding {
    readonly grants?: ToolCallGrants | undefined;
    readonly ticket?: string | undefined;
    // Ends the request when aborted.
    readonly signal?: AbortSignal | undefined;
}

// (2026-11-26) One call of a page tool in the sandbox's signed-in browser of an account the turn holds: `tool` as the
// agent's `browser` server names it (`browser_navigate`, `browser_evaluate`, `browser_click`, …), `args` its arguments
// without `account`. Only the page's own tools, and only on the account's sites: a navigation elsewhere is refused, a
// call on a page elsewhere is refused, and a call that leaves them has its answer withheld.
export interface BrowserCall {
    readonly account: string;
    readonly tool: string;
    readonly args?: ToolArguments | undefined;
}

// (2026-11-26) One call of a tool of the owner's own browser the turn holds (`open`, `read`, `click`, …, as the agent's
// server for that browser names them), through the same door as the agent's: the browser's own site switches apply.
export interface OwnerBrowserCall {
    readonly browser: string;
    readonly tool: string;
    readonly args?: ToolArguments | undefined;
}

// A tool's arguments, as a tool of the agent's is called with them.
export type ToolArguments = Parameters<ToolDefinition["call"]>[0];

// (2026-11-26) What a job's work came to: `output` is what `wait` and the conversation's wake hand the agent, cut in the
// middle past the job's bound.
export interface JobEnd {
    readonly ok: boolean;
    readonly output: string;
}

// (2026-11-26) A job's work while it runs: its id, the grants and ticket of the call that started it (good for as long
// as the job runs; the sandbox's own browsers only while that call's turn still runs, the owner's browser throughout),
// and a line onto what the job shows meanwhile. `signal` aborts once the job is stopped, by the agent or a person.
export interface RunningJob {
    readonly id: string;
    readonly grants: ToolCallGrants;
    readonly ticket: string;
    readonly signal: AbortSignal;
    say(line: string): void;
}

// (2026-11-26) A background job a tool starts in the calling conversation, as a `run_in_background` command is one:
// `command` is how `wait` and the transcript name it, `description` what the conversation's card shows, `started` its
// output until it ends (what it is doing, and what to do if a restart takes it down meanwhile). In a `lane`, at most
// `most` (1 when absent) of that lane run at once, first come first served, and never two naming one `key` at once.
export interface JobSpec {
    readonly command: string;
    readonly description: string;
    readonly started: string;
    readonly lane?: { readonly name: string; readonly key?: string | undefined; readonly most?: number | undefined } | undefined;
    // The work, run once the job's turn in its lane comes; a throw ends the job as failed with its message.
    readonly run: (job: RunningJob) => Promise<JobEnd>;
}

// (2026-11-26) A job filed: its id, which the agent's `wait` takes, and how many runs of its lane were ahead of it.
export interface StartedJob {
    readonly id: string;
    readonly ahead: number;
}

export interface ToolDefinition {
    // The name the model calls it by, under the server's own `mcp__<server>__` prefix.
    readonly name: string;
    readonly description: string;
    // A JSON Schema object for the arguments (`z.toJSONSchema(schema)` produces one).
    readonly inputSchema: Readonly<Record<string, unknown>>;
    // What one call can do to the world: `read` changes nothing, so a runtime may run several at once and allow it where
    // writes are held; `write` changes something recoverable; `destructive` may lose something. Listed to the model as
    // MCP annotations. Undeclared, it is listed with none, which Claude Code reads as a destructive write run alone.
    readonly effect?: ToolEffect;
    // A string answers as text, a ToolResult as itself, anything else as its JSON; a throw answers as a tool error.
    readonly call: (args: Readonly<Record<string, unknown>>, context: ToolCallContext) => Promise<ToolResult | string | unknown> | ToolResult | string | unknown;
}

// One request into this extension's `/x/<id>` namespace, prefix already stripped. Return `undefined` for "not mine":
// the host answers 404.
export type BackendRouteHandler = (request: Request) => Promise<Response | undefined>;

// (2026-11-26) Who is calling through `/x/<id>`, as the daemon verified them (`api.caller(request)`): a person signed in,
// a repository's operator panel, a program holding a control token, another extension's backend, or nobody at all on a
// sandbox that runs without sign-in. Read off an assertion the daemon minted for this extension and this request, good
// for two minutes, which no extension can mint: `asCaller` hands it back to the daemon to act as that person.
export type ExtensionCallerWho =
    | {
          readonly kind: "person";
          readonly email: string;
          readonly name?: string | undefined;
          // Their access tier: guest, viewer, collaborator, writer, maintainer or owner.
          readonly tier: MemberTier;
          // The area ids their access is fenced to; absent for the whole workspace.
          readonly areas?: readonly string[] | undefined;
          // The parts of the sandbox they were given to run (people, secrets, privacy, ownAccounts).
          readonly manages?: readonly string[] | undefined;
      }
    | { readonly kind: "panel" }
    | { readonly kind: "program"; readonly id: string; readonly label: string }
    | { readonly kind: "extension"; readonly id: string }
    | { readonly kind: "local" };

export type ExtensionCaller = ExtensionCallerWho & {
    // The workspace folders (relative to `workspaceRoot`) this caller may read: absent for the whole workspace, empty for
    // none of it. Only a person with areas is fenced; every other kind reads it whole, as the daemon's own routes answer it.
    readonly folders?: readonly string[] | undefined;
    // Whether a workspace-relative path is inside `folders`, by segment (`app2` is not inside `app`); a path that climbs
    // out of the workspace is inside nothing.
    readonly reaches: (path: string) => boolean;
    // When the assertion stops being believed (ms); `asCaller` past it is refused.
    readonly expiresAt: number;
    // The assertion itself, as the daemon minted it.
    readonly assertion: string;
};

// (2026-11-26) What the daemon checked of a call through one of this extension's public routes before handing it over
// (`contributes.publicRoutes`), as `api.publicRoutes.serve` hears it.
export interface PublicRouteVerification {
    // The declared route it landed on, as the manifest spells its path.
    readonly route: string;
    // The automation an automation-scoped route is for: on this extension's own listener provider, and switched on.
    readonly automationId?: string | undefined;
    // The browser's Origin, on the automation's allowed origins when the route checks them.
    readonly origin?: string | undefined;
    // Admitted by the automation's door key in place of a listed Origin; the key itself is not handed on.
    readonly keyed?: boolean | undefined;
    // Signed by the provider with the route's secret under this scheme, and the provider's id for the delivery, which no
    // earlier call the door took carried.
    readonly signature?: { readonly scheme: WebhookSignatureScheme; readonly deliveryId?: string | undefined } | undefined;
    // The caller id a solved proof-of-work challenge was signed to.
    readonly proofOfWork?: { readonly caller: string } | undefined;
    // (2026-11-26) A Cloudflare Turnstile token passed, verified by the daemon with Cloudflare under the route's secret.
    readonly turnstile?: true | undefined;
    // The caller's address as the edge forwarded it: advisory, never an identity.
    readonly remoteIp?: string | undefined;
    // When the daemon took it (ms).
    readonly at: number;
}

// (2026-11-27) What `api.sleep` hands its callers (server-reach.ts).
export type { SleepBoot, SleepHandler, SleepHeardMessage, SleepNotice } from "./server-reach.js";
// (2026-11-28) What `api.identity` hands its callers (server-reach.ts).
export type { IdentityPayload, IdentityReach, IdentitySigned, SandboxIdentity } from "./server-reach.js";

// One call through a public route, path relative to /door/<id>, its door key (if any) already taken off. Return
// `undefined` for "not mine": the host answers 404.
export type PublicRouteHandler = (request: Request, verified: PublicRouteVerification) => Promise<Response | undefined> | Response | undefined;

// An action in the approvals queue that names this extension as its `performer`, handed over by the daemon only after
// it found a person's yes on record matching the item as it stands, and spent that yes. The workspace file is never
// what decides: an item marked approved without a recorded yes, or changed since, never reaches the backend.
export interface ApprovedAction {
    // The item's id in the approvals queue.
    readonly id: string;
    // `performer.digest` as the yes pinned it: the SHA-256 the extension wrote when it held the act. The extension
    // recomputes it over what it is about to do and refuses on any difference.
    readonly digest: string;
    // The item's headline and details, exactly as they stood when the person said yes.
    readonly summary: string;
    readonly details: string;
    // Who said yes (their sign-in) and when, as the daemon recorded it. No approver when the sandbox runs without
    // sign-in. A yes given again (a retry) has a later `approvedAt`, so the pair names one yes.
    readonly approver?: string | undefined;
    readonly approvedAt: number;
    // The sandbox's action rules as the daemon reads them now, organisation pins applied: a rule set to deny after the
    // yes still refuses.
    readonly actionRules: Readonly<Record<string, string>>;
    // (2026-11-28) Their passkey over exactly this (sandbox, `id`, `digest`), when approved with one; one filed `required`
    // checks it is here (a turn can rewrite the item) with `verifyPasskeyCosign`. Anyone may check it once published.
    readonly cosign?: PasskeyCosign | undefined;
}

// What carrying out an approved action came to, in the three states the queue keeps apart.
export type ApprovedActionOutcome =
    // It happened. `result` is the row's one line: a registry number, a task id.
    | { readonly outcome: "done"; readonly result: string }
    // It did not happen and nothing reached the outside world, so a new yes may safely run it again.
    | { readonly outcome: "refused"; readonly error: string }
    // It may have happened: the request went out and its answer failed or was lost part-way. The queue never repeats
    // it by itself; the person checks the outside system first.
    | { readonly outcome: "uncertain"; readonly error: string };

export type ApprovedActionHandler = (action: ApprovedAction, context: { readonly signal: AbortSignal }) => Promise<ApprovedActionOutcome>;

// (2026-11-26) A post in the approvals queue for a platform one of this extension's cards publishes on
// (`channel.publish`, the post's `platform` naming the card's id), handed over by the daemon's approvals executor only
// after it found a person's yes on record matching the post as it stands, and spent that yes. Its words are the ones the
// person approved: publish them as they are, or refuse.
export interface ApprovedPost {
    // The item's id in the approvals queue.
    readonly id: string;
    // The card id the post names, lowercased (`discord`).
    readonly platform: string;
    // Exactly what to publish.
    readonly content: string;
    // A headline, where the post carries one.
    readonly title?: string | undefined;
    // Where it goes, matching the card's declared `channel.publish.target` pattern.
    readonly target: string;
    // Who said yes (their sign-in) and when, as the daemon recorded it, as for an action.
    readonly approver?: string | undefined;
    readonly approvedAt: number;
    // The sandbox's action rules as the daemon reads them now, organisation pins applied.
    readonly actionRules: Readonly<Record<string, string>>;
}

// What publishing it came to, in the queue's three states; a `done` result is the row's link (the message's URL) or line.
export type ApprovedPostHandler = (post: ApprovedPost, context: { readonly signal: AbortSignal }) => Promise<ApprovedActionOutcome>;

// (2026-11-26) One automation's fire, handed to the handler its target names: an automation saved with
// `target: { kind: "extension", extension: "<publisher.name>", handler }` by this extension itself fires it on its trigger,
// under the scheduler's admission, held wakes and fire journal, with no agent. `id` is the same on every try: a handler
// told twice (the daemon stopped before it heard the answer) can tell.
export interface AutomationFire {
    readonly id: string;
    readonly automationId: string;
    readonly handler: string;
    // When the automation fired (ms). A fire made while the backend was down is handed over once it is back, late.
    readonly firedAt: number;
    // How many earlier fires of the same automation this one stands for, fired while the backend was down.
    readonly coalesced: number;
    // The trigger's payload (a webhook's body, a workspace event) and what the automation's check saw, when there.
    readonly payload?: string | undefined;
    readonly observed?: string | undefined;
    // The automation's own words (its `prompt`).
    readonly prompt: string;
}

// Answers once the fire is taken; a throw is recorded on the automation's run as an error and the fire is not tried
// again. Bounded by the daemon's ten-minute deadline: long work holds itself (`api.work.hold`) and returns.
export type AutomationFireHandler = (fire: AutomationFire, context: { readonly signal: AbortSignal }) => void | Promise<void>;

// (2026-11-26) One check of a watch kind this extension declares (`contributes.watchKinds`), handed to the handler
// `api.checks.serve` registered for it, from the daemon's automations engine alone through a door of the backend host no
// person's, panel's or agent's token reaches: on an automation's trigger, when the composer's Check now is pressed, and
// when an agent proposes a watch of this kind.
export interface WatchCheck {
    readonly kind: string;
    // The source's parameters as the automation stores them, already checked against the kind's declared fields.
    readonly params: Readonly<Record<string, string | boolean>>;
    // What the last passing check saw, cut to the daemon's bound: a check that words what changed reads it. Absent
    // before the first pass, and for a check tried by hand.
    readonly last?: string | undefined;
    // The credential-gateway addresses of the cards the kind names in `capabilities`, as the automation's role reaches
    // them, under the names a turn's shell sees them by (`GITHUB_API_URL_<CARD>`). Never a credential: the gateway signs
    // what is sent through them. Empty when no such card is connected, or the role reaches none.
    readonly reach: Readonly<Record<string, string>>;
    // The automation it checks for; absent for a check tried by hand.
    readonly automationId?: string | undefined;
}

// What a check came to. A pass carries what it saw: what `fireOn: change` compares and the wake is told, so only what
// names the thing watched belongs in it (a release's tag, not its notes). A miss carries what it is still waiting for, in
// a sentence the automation's run history shows.
export type WatchCheckAnswer = { readonly pass: true; readonly output: string } | { readonly pass: false; readonly detail: string };

// Answers within the daemon's deadline (a minute); a throw reads as a check that did not pass, its message the detail.
export type WatchCheckHandler = (check: WatchCheck, context: { readonly signal: AbortSignal }) => WatchCheckAnswer | Promise<WatchCheckAnswer>;

// An extension's own setting values, keyed as its manifest's `contributes.settings` declares them.
export type ExtensionSettingValues = Readonly<Record<string, string | number | boolean>>;

// A file the extension keeps in its own state directory, read through the conversions its shape has had and written
// with what a newer version of the extension put in it kept in place: the evolution `sandboxDocument` gives the browser
// half, and the daemon's own stores have. A file that exists but this version cannot read is left alone: `update`
// rejects rather than writing the fallback over it.
export interface ServerDocument<T> {
    // Today's value: the file converted and parsed; the fallback when it is absent or this version cannot read it.
    read(): Promise<T>;
    // Read-change-write, serialized against every other handle on the same file, written whole by a rename so a reader
    // never sees half of it. Answers what is stored afterwards; returning `current` unchanged writes nothing.
    update(change: (current: T) => T): Promise<T>;
}

// What a stored document holds before its parse: JSON, after the conversions its shape has had.
export type StoredJson = string | number | boolean | null | readonly StoredJson[] | { readonly [key: string]: StoredJson };

export interface ServerDocumentOptions<T> {
    // Today's shape, or undefined for a file this version cannot read.
    readonly parse: (raw: StoredJson) => T | undefined;
    readonly fallback: () => T;
    // Append-only: a conversion is never edited or removed once shipped, only followed by another.
    readonly history?: readonly Conversion[];
    // Where the conversions apply: the document, each entry of a top-level array, or each value of an object keyed by id.
    readonly granularity?: Granularity;
}

// How a backend is doing, by its own account (`ServerActivation.health`), shown on its row in the Extensions list.
// `starting`: activated, still getting ready. `degraded`: serving, but something it relies on is not (a connection
// down, a download that failed), which `detail` says. `failed`: not serving at all.
export type ExtensionHealthState = "ok" | "starting" | "degraded" | "failed";

export interface ExtensionHealth {
    readonly state: ExtensionHealthState;
    // One sentence for the owner, required in spirit for anything but `ok`: a state with no stated reason is an opinion.
    readonly detail?: string;
}

// What `activateServer` may hand back: the two things only the extension can do for itself.
export interface ServerActivation {
    // Release what activation opened (listeners, timers, child processes, connections), before the host replaces this
    // extension's code or stops. With one, a change that touches only this extension (a rebuild, an update, a toggle)
    // reloads it alone and leaves every other backend running; without one, the whole host restarts. Bounded by the
    // host's deadline, after which the code is replaced anyway.
    readonly deactivate?: () => void | Promise<void>;
    // Asked on the host's health sweep and answered within its deadline; one that throws or does not answer in time
    // reads as `degraded`. Absent: the backend reads as `ok` while its activation stands.
    readonly health?: () => ExtensionHealth | Promise<ExtensionHealth>;
}

export interface ExtensionServerApi {
    // The host's @intentic/extension-api version, checked against `engines.intentic`.
    readonly apiVersion: string;
    // Absolute workspace root; the backend reads and writes it directly via node's `fs`, no file service in between.
    readonly workspaceRoot: string;
    // This extension's own checkout (absolute), where its bundled assets sit.
    readonly extensionDir: string;
    // This extension's own state directory (absolute), created before activation and keyed by `publisher.name`, so it
    // survives an update, a re-install and dev mode alike. Never versioned, never backed up, not carried to another
    // sandbox: resume marks, cached tokens, a listener's last port. Removing the extension deletes it.
    readonly stateDir: string;
    // This extension's own cache directory (absolute): what can be fetched or built again (a downloaded engine, an
    // index). Created before activation, ignored by the workspace watcher, deleted with the extension.
    readonly cacheDir: string;
    // A line in the daemon's log, attributed to this extension.
    readonly log: (message: string) => void;
    // A JSON file of the extension's own under `stateDir` (`path` is relative to it), evolved by its conversions.
    readonly document: <T>(path: string, options: ServerDocumentOptions<T>) => ServerDocument<T>;
    // The extension's own settings (`contributes.settings`), secret values included, as the owner set them now. Reached
    // without declaring anything in `permissions.daemon`: the daemon answers only about the extension asking.
    readonly settings: {
        get(): Promise<ExtensionSettingValues>;
        // Fires with the keys whose value changed, however they changed: the Extensions tab, an agent, a hand edit.
        onDidChange(listener: (keys: readonly string[]) => void): Disposable;
    };
    // Changes in the workspace as the daemon sees them, over one stream the host opens on the first listener and closes
    // with the last. The browser half's `onDidChangeFiles` is narrowed to the extension's own `contributes.files`; this
    // one is every change, since a backend reads the whole workspace anyway.
    readonly workspace: {
        // Workspace-relative paths written, created or deleted, in batches; an empty batch is a write the watcher
        // could not name (a build under a pruned directory), which a reader treats as "anything may have changed".
        onDidChangeFiles(listener: (paths: readonly string[]) => void): Disposable;
        // Repositories whose refs moved: a commit, a checkout, a branch or tag, a rebase.
        onDidChangeRefs(listener: (repos: readonly string[]) => void): Disposable;
        // The repository set itself moved (a clone, a scaffold, a delete); answers the whole set.
        onDidChangeRepos(listener: (repos: readonly string[]) => void): Disposable;
    };
    // (2026-11-26) What the sandbox tells this extension's code without an agent turn, each kind declared in
    // `permissions.events` (a listener of an undeclared kind throws, naming the field). Over the same stream as
    // `workspace`; a stream that dropped and came back may have missed a run ending, which a reader catches up on by
    // reading the conversation.
    readonly events: {
        // A run ending in a conversation this extension started through POST /agent with its own token (`run`).
        onRunSettled(listener: (run: RunSettled) => void): Disposable;
        // Whether any agent turn is running in the sandbox (`activity`): told as the stream opens, then each time it flips.
        onActivity(listener: (activity: SandboxActivity) => void): Disposable;
        // (2026-11-26) Each run that finished and each job that ended on the workspace's forges, as the core heard it from
        // a webhook or its poller (`ci`): one frame a batch. An empty batch follows a gap in the stream, when frames may
        // have been missed: a reader catches up from the forge's own word (GET /ci/runs) then.
        onCi(listener: (events: readonly CiFeedEvent[]) => void): Disposable;
    };
    // (2026-11-26) Work in flight (`permissions.work`): while a hold stands the sandbox stays awake and an update or a
    // restart waits for it, as for an agent's turn, named by its label. Disposing lets it go, and so does this backend
    // dying; after a daemon restart the runtime holds again. Throws when the manifest does not declare `work`.
    readonly work: {
        hold(label: string): Disposable;
    };
    // (2026-11-26) Runs one command to its end under a workload class the manifest declares (`permissions.exec`),
    // admitted by the sandbox's memory budget, and for `toolchain` queued with every agent's builds and tests, instead
    // of competing with them. Never a shell: `argv` runs as given. Rejects when the class is not declared or the daemon
    // refuses the request; a command that fails answers with its exit code.
    readonly exec: (argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
    // (2026-11-26) Rows in the sandbox's activity feed, as this extension's own: the daemon names the extension on each
    // from its token. Reached without declaring anything; rejects with the daemon's words when refused.
    readonly activity: {
        append(row: ActivityRow): Promise<void>;
    };
    // (2026-11-27) Hosted sleep, for code that must hear what arrives while the sandbox sleeps (a chat gateway, a webhook
    // receiver). A sandbox the platform hosts stops when nobody uses it; a request at one of its wake doors starts it
    // again, its sender answered 503 with `Retry-After` while it boots, so only a sender that retries is heard (Slack and
    // Telegram do; GitHub does not redeliver unasked). The backend and every declared process get it, undeclared.
    readonly sleep: {
        // The full public URL of one of this extension's own public routes declaring `wakes: true`, path as the manifest
        // spells it (`*/events`), its `*` filled with `automationId` for an automation's route, and the wake secret in
        // its query (`?wake=`, which the door takes off before the backend hears the call). The same URL on every call
        // and after every restart, so it is the one to paste into a provider's webhook setting (Slack's Request URL,
        // Telegram's setWebhook). A call there wakes the sandbox only while an automation on the extension's listener
        // provider is switched on (the one it names, for an automation's route). Rejects for a route not declared so, and
        // on a sandbox with no public address.
        wakeUrl(route: string, options?: { readonly automationId?: string | undefined }): Promise<string>;
        // Runs `handler` right before the hosted machine sleeps, after the platform has saved its wake doors: the moment
        // to point a provider at a wake URL (Telegram's setWebhook in place of long polling). Every handler of every
        // extension runs at once and all of them share one deadline, `notice.deadline` (ms; about ten seconds), after
        // which the machine stops whether or not they finished. Once asked, the sleep is never called off. Disposing
        // stops hearing; nothing is told on a sandbox that never sleeps (one on somebody's own computer).
        beforeSleep(handler: SleepHandler): Disposable;
        // What this boot follows (`SleepBoot`): whether the last stop was a hosted sleep (the moment to undo what
        // `beforeSleep` did), and whether a request at a wake door started it. Resolves within about fifteen seconds of
        // the daemon's boot; a daemon from before it answers false for both.
        boot(): Promise<SleepBoot>;
        // (2026-11-27, 2.58.0) What the platform heard for this extension's own connections while the sandbox slept,
        // oldest first: a card declaring `sleepWatch` whose owner let the platform hold its credential (Discord's bot)
        // has the platform note where each message for it is. Fetch each one and answer it as if it had just arrived.
        // Handed over once: asking forgets them. Empty on a sandbox the platform does not host; rejects when the
        // platform could not say, leaving them there to ask again.
        heard(): Promise<readonly SleepHeardMessage[]>;
    };
    // (2026-11-28) This sandbox's identity: its public document, and records signed as it with its key, which never
    // reaches this code (server-reach.ts IdentityReach). The backend and every declared process get it.
    readonly identity: IdentityReach;
    readonly routes: {
        // Serves this extension's route namespace; the daemon proxies /x/<id>/* here through its ordinary auth. A
        // second mount replaces the first.
        mount(handler: BackendRouteHandler): void;
    };
    // (2026-11-26) Who a request through `/x/<id>` comes from, as the daemon verified them; undefined for a request the
    // daemon did not attach one to (a daemon from before 2.53.0), one minted for another extension, or one past its
    // window.
    readonly caller: (request: Request) => ExtensionCaller | undefined;
    // (2026-11-26) The routes anyone on the internet may call (`contributes.publicRoutes`), served at /door/<id>/<path>:
    // reached only once the daemon's own protections passed the call, never through `/x/<id>`, whose handler hears only
    // people signed in. A second serve replaces the first.
    readonly publicRoutes: {
        serve(handler: PublicRouteHandler): void;
    };
    // The agent's tools (`contributes.tools`). The host owns the MCP transport, its deadlines and the card lookup: it
    // answers the handshake, lists what `tools` returns for the card a server was mounted for (undefined for an
    // extension-level server), and runs a call with its arguments. `tools` runs per request, so what it returns may
    // follow the card's switches. A second serve replaces the first.
    readonly tools: {
        serve(tools: (card: ToolCard | undefined) => readonly ToolDefinition[] | Promise<readonly ToolDefinition[]>): void;
    };
    // The approved actions this extension carries out itself, in place of an agent turn: an approvals-queue item whose
    // `performer` names this extension reaches `perform` from the daemon's approvals executor alone, through a door of
    // the backend host that no /x route, panel or agent token reaches, after the daemon has matched and spent the yes.
    // The credentials stay in the backend, read from the daemon. A second perform replaces the first.
    // (2026-11-26) `publish` is the same door for an approved post on a platform a card of this extension declares it
    // publishes on (`channel.publish`), in place of an agent turn driving the logged-in browser. A second publish
    // replaces the first.
    readonly approvals: {
        perform(handler: ApprovedActionHandler): void;
        publish(handler: ApprovedPostHandler): void;
    };
    // (2026-11-26) The handlers an automation fires in this backend (`permissions.fires` declares each name): reached
    // from the daemon's automations engine alone, through a door of the backend host no /x route, panel or agent token
    // reaches. A second handler for one name replaces the first; registering an undeclared name throws.
    readonly automations: {
        onFire(handler: string, listener: AutomationFireHandler): Disposable;
    };
    // (2026-11-26) What its agent tools may do with the grants of the turn calling them, each a power the manifest declares
    // in `permissions.turn` and the daemon refuses undeclared, and anything the turn does not hold either way. Each takes
    // the call's context (or a running job's), and rejects with the daemon's words when refused.
    // The sandbox's signed-in browser of an account the turn holds, on that account's sites (`browser`). The turn's own
    // browser: the account's page is the one the agent's `browser` tools drive, so a call takes its tab.
    readonly browser: {
        call(standing: TurnStanding, call: BrowserCall): Promise<ToolResult>;
    };
    // The owner's own browser the turn holds (`owner-browser`).
    readonly ownerBrowser: {
        call(standing: TurnStanding, call: OwnerBrowserCall): Promise<ToolResult>;
    };
    // A background job in the calling conversation (`jobs`), answered once filed: its work runs in this backend while
    // the agent goes on, and the agent collects its end with `wait`, or is woken by it.
    readonly jobs: {
        start(standing: TurnStanding, spec: JobSpec): Promise<StartedJob>;
    };
    // (2026-11-26) The checks of the watch kinds this extension declares (`contributes.watchKinds`), one handler per kind:
    // reached from the daemon's automations engine alone, through a door of the backend host. A second handler for one
    // kind replaces the first; serving a kind the manifest does not declare throws.
    readonly checks: {
        serve(kind: string, handler: WatchCheckHandler): Disposable;
    };
    // Authenticated transport to the daemon's own routes; every call is checked against the manifest's
    // `permissions.daemon` allowlist.
    readonly daemon: {
        // The daemon's contract, typed: a call names a procedure and its answer arrives parsed by the procedure's output
        // schema. Refused before anything is sent unless `permissions.daemon` covers the method and path it resolves to.
        readonly rpc: ContractRouterClient<typeof sandboxContract>;
        // For what the contract does not carry: bytes (`/workspace/raw`) and the daemon's hand-written routes.
        request(path: string, init?: RequestInit): Promise<Response>;
        json<T>(path: string, init?: RequestInit): Promise<T>;
        // (2026-11-26) The same doors carrying a caller's assertion beside the extension's token, for the routes that act
        // as whoever pressed: POST /agent starts the turn as that person, held to their access as it stands then. Every
        // other route answers by the extension's own reach. The daemon refuses an assertion past its window, minted for
        // another extension or in another sandbox.
        asCaller(caller: ExtensionCaller): DaemonDoors;
    };
}

// Authenticated transport to the daemon's own routes, as `api.daemon` and `api.daemon.asCaller(caller)` both carry it.
export type DaemonDoors = Omit<ExtensionServerApi["daemon"], "asCaller">;

export interface ExtensionServerContext {
    // This extension's routing id, its /x/<id> namespace segment.
    readonly extensionId: string;
}

// What a declared process (`contributes.processes`) gets, from `connectExtensionProcess` in
// `@intentic/extension-api/runtime`: the backend's api without the halves only the backend host can serve. A process
// answers on its own port, so it mounts no routes, serves tools there (`contributes.tools.process`), carries out no
// approved action, is woken by no automation, answers no watch's check and no public route, hears no `/x` caller, and
// (serving no tool through the host) reaches no turn; it hears, holds and runs the way the backend does.
export type ExtensionProcessApi = Omit<
    ExtensionServerApi,
    "routes" | "tools" | "approvals" | "automations" | "checks" | "caller" | "publicRoutes" | "browser" | "ownerBrowser" | "jobs"
>;

// Shape of the manifest `server` bundle's default (or named) export; `activateServer` runs once per activation, which
// is once per backend-host start unless the extension returns a `deactivate`, after which a change to it alone
// activates it again in place.
export interface ExtensionServerModule {
    activateServer(api: ExtensionServerApi, context: ExtensionServerContext): void | ServerActivation | Promise<void | ServerActivation>;
}
