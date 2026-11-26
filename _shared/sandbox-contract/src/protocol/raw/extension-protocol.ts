import { EXTENSION_DECLARED_EVENTS, EXTENSION_EXEC_CLASSES, EXTENSION_FIRE_HANDLER, EXTENSION_TURN_POWERS } from "@intentic/extension-manifest/permissions";
import { z } from "zod";
import { MemberTierSchema } from "../../schemas/shared.js";
import type { WebhookSignatureScheme } from "../../schemas/automations.js";
import { rawRouteUrl } from "./raw-routes.js";

// The wire between the daemon and an extension's own code, its backend in the shared host and its declared processes
// alike: the two routes every extension token reaches about itself (EXTENSION_OWN_ROUTES in extension-manifest), and
// the environment a process is started with. `@intentic/extension-api/runtime` reads both, so the daemon and the SDK
// compile against one declaration. A subpath of its own, since a gateway process loads no more of the contract than it
// needs (the root builds every schema there is).

// GET /extension/settings: the calling extension's own settings, secret values included, keyed by the declaration.
export const ExtensionOwnSettingsSchema = z.object({
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type ExtensionOwnSettings = z.infer<typeof ExtensionOwnSettingsSchema>;

// (2026-11-26) A run ending in a conversation the calling extension started (POST /agent with its own token): which run,
// how it ended, and its last top-level prose (cut to EXTENSION_RUN_CLOSING_MAX characters). Sent only to an extension
// that declared `run` in `permissions.events` and asked for it.
export const ExtensionRunSettledSchema = z.object({
    kind: z.literal("run"),
    conversationId: z.string(),
    run: z.string(),
    // `stopped`: a person's stop or a parent's cancel ended it rather than the turn itself.
    outcome: z.enum(["done", "failed", "stopped"]),
    error: z.string().optional(),
    closing: z.string(),
});
export type ExtensionRunSettled = z.infer<typeof ExtensionRunSettledSchema>;
export const EXTENSION_RUN_CLOSING_MAX = 20_000;

// GET /extension/events: one ndjson frame per line, for as long as the caller holds the stream. A heartbeat every
// EXTENSION_EVENTS_HEARTBEAT_MS says the daemon is still there; the rest name what moved. `settings` carries only the
// calling extension's own keys whose value changed. `run` and `activity` come only when asked for by name
// (EXTENSION_EVENTS_KINDS_PARAM) and declared: `activity` says whether any agent turn runs, once as the stream opens and
// again each time that flips.
export const ExtensionEventSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("heartbeat") }),
    z.object({ kind: z.literal("files"), paths: z.array(z.string()) }),
    z.object({ kind: z.literal("refs"), repos: z.array(z.string()) }),
    z.object({ kind: z.literal("repos"), repos: z.array(z.string()) }),
    z.object({ kind: z.literal("settings"), keys: z.array(z.string()) }),
    ExtensionRunSettledSchema,
    z.object({ kind: z.literal("activity"), live: z.boolean() }),
]);
export type ExtensionEvent = z.infer<typeof ExtensionEventSchema>;

export const EXTENSION_EVENTS_HEARTBEAT_MS = 15_000;

// The kinds a listener subscribes to without declaring them.
export const EXTENSION_EVENT_KINDS = ["files", "refs", "repos", "settings"] as const;
export type ExtensionEventKind = (typeof EXTENSION_EVENT_KINDS)[number];

// The kinds an extension hears only once its manifest declares them (`permissions.events`), asked for on the stream by
// name: `?kinds=run,activity`. The daemon refuses the stream (403) when one asked for is not declared, and sends no
// frame of a kind not asked for, so a runtime from before them is sent none.
export { EXTENSION_DECLARED_EVENTS };
export const ExtensionDeclaredEventSchema = z.enum(EXTENSION_DECLARED_EVENTS);
export const EXTENSION_EVENTS_KINDS_PARAM = "kinds";

// A backend's own account of itself (`ServerActivation.health` in @intentic/extension-api), as the host reads it from
// the extension's code and passes it on: a closed set of states and an optional sentence.
export const ExtensionHealthSchema = z.object({
    state: z.enum(["ok", "starting", "degraded", "failed"]),
    detail: z.string().optional(),
});

// POST /extension/work/hold: work in flight, held for as long as the caller keeps the answer open. An ndjson stream of
// heartbeats; while it is open the sandbox counts the hold as work a restart or an idle stop waits for, named by its
// label, and closing it (or the caller dying) lets it go. Refused (403) unless the manifest declares `permissions.work`.
export const ExtensionWorkHoldSchema = z.object({
    label: z.string().trim().min(1).max(120).describe("What the work is, as the sandbox names it to whoever waits on it."),
});
export type ExtensionWorkHold = z.infer<typeof ExtensionWorkHoldSchema>;

// POST /extension/exec: one command run to its end under a workload class the manifest declares (`permissions.exec`),
// admitted by the sandbox's memory budget first and, for `toolchain`, queued with the heavy commands. Never a shell: the
// argv runs as given.
export const ExtensionExecClassSchema = z.enum(EXTENSION_EXEC_CLASSES);
export const EXTENSION_EXEC_TIMEOUT_MAX_MS = 2 * 60 * 60_000;
export const EXTENSION_EXEC_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
export const ExtensionExecSchema = z.object({
    argv: z.array(z.string()).min(1).describe("The program and its arguments."),
    class: ExtensionExecClassSchema,
    // Absolute, or relative to the workspace root; the workspace root when absent.
    cwd: z.string().min(1).optional(),
    // Laid over the daemon's own environment.
    env: z.record(z.string(), z.string()).optional(),
    stdin: z.string().optional(),
    timeoutMs: z.number().int().positive().max(EXTENSION_EXEC_TIMEOUT_MAX_MS),
    // Kept per stream; past it the stream is still read, and `truncated` says so.
    outputBytes: z.number().int().positive().max(EXTENSION_EXEC_OUTPUT_MAX_BYTES),
    // Which end of an overflowing stream is kept.
    keep: z.enum(["head", "tail"]).optional(),
    // What the queue and the process list call it.
    label: z.string().trim().min(1).max(120).optional(),
});
export type ExtensionExec = z.infer<typeof ExtensionExecSchema>;
export const ExtensionExecResultSchema = z.object({
    // Set when the sandbox did not start it: no room came free within its deadline. Nothing ran.
    refused: z.string().optional(),
    // How long it waited for room or a queue slot before it started.
    waitedMs: z.number(),
    // Undefined when it did not exit by itself: ended here (`ended`), never started (`spawnError`), or by a signal.
    exitCode: z.number().optional(),
    signal: z.string().optional(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    ended: z.enum(["timeout", "aborted"]).optional(),
    spawnError: z.string().optional(),
});
export type ExtensionExecResult = z.infer<typeof ExtensionExecResultSchema>;

// (2026-11-26) What an agent tool's call is told of the turn that made it, from the turn's own grants (its role and the
// reach of the people it is for): the sandbox browser accounts it holds, each with the sites it signs in on (sign-in
// families applied, as `type_credential` holds a page to them); the owner's own browsers it holds; and the cards it
// holds that the called extension contributes. Never a credential, and never more than the turn holds.
export const ToolGrantAccountSchema = z.object({
    id: z.string().min(1),
    kind: z.enum(["browser", "identity"]),
    sites: z.array(z.string()),
});
export type ToolGrantAccount = z.infer<typeof ToolGrantAccountSchema>;
export const ToolCallGrantsSchema = z.object({
    accounts: z.array(ToolGrantAccountSchema),
    browsers: z.array(z.string()),
    cards: z.array(z.string()),
});
export type ToolCallGrants = z.infer<typeof ToolCallGrantsSchema>;
export const NO_TOOL_GRANTS: ToolCallGrants = { accounts: [], browsers: [], cards: [] };

// What a tool call's own work may do with those grants (`permissions.turn`).
export const ExtensionTurnPowerSchema = z.enum(EXTENSION_TURN_POWERS);

// The page tools an extension's tool may call in an account's browser (@playwright/mcp's names, and the router's WebMCP
// call on the page): `browser_run_code_unsafe` runs in Playwright's process against the whole browser, every site's
// cookies included; the network tools carry a session's headers; the tab list names every site the profile has open.
export const EXTENSION_BROWSER_TOOLS = [
    "browser_navigate",
    "browser_navigate_back",
    "browser_snapshot",
    "browser_take_screenshot",
    "browser_evaluate",
    "browser_click",
    "browser_hover",
    "browser_drag",
    "browser_type",
    "browser_press_key",
    "browser_select_option",
    "browser_fill_form",
    "browser_file_upload",
    "browser_handle_dialog",
    "browser_wait_for",
    "browser_resize",
    "browser_webmcp_call",
] as const;

// What a navigation's arguments name: where it goes, which must be on the account's sites.
export const ExtensionNavigateArgumentsSchema = z.looseObject({ url: z.string() });

// POST /extension/turn/browser (2026-11-26): one tool call to the sandbox's signed-in browser of an account the calling
// turn holds, through that turn's own browser router, held to the account's own sites. `turn` is the call's ticket (or
// a job's that the call started), minted by the daemon for the extension whose tool it is.
export const ExtensionBrowserCallSchema = z.object({
    turn: z.string().min(1),
    account: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
});
export type ExtensionBrowserCall = z.infer<typeof ExtensionBrowserCallSchema>;

// POST /extension/turn/owner-browser (2026-11-26): one tool call to the owner's own browser (a `webext` card) the calling
// turn holds, through its peer door, where the browser's own site switches apply.
export const ExtensionOwnerBrowserCallSchema = z.object({
    turn: z.string().min(1),
    browser: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
});
export type ExtensionOwnerBrowserCall = z.infer<typeof ExtensionOwnerBrowserCallSchema>;

// What either call answers: the tool's result as MCP carries it, stored secrets masked to their references. A refusal of
// the core's (no such grant, a site outside the account's, an undeclared power) is a 4xx with `{ error }` instead.
export const ExtensionToolResultSchema = z.looseObject({ content: z.array(z.unknown()), isError: z.boolean().optional() });
export type ExtensionToolResult = z.infer<typeof ExtensionToolResultSchema>;
export const ExtensionTurnCallAnswerSchema = z.object({ result: ExtensionToolResultSchema });
// The blocks of a result an extension's tool reads (`ToolContent` in @intentic/extension-api); any other kind of block
// is left out of what it is handed.
export const ExtensionToolContentSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
]);
// A refusal from one of the turn doors or the jobs doors.
export const ExtensionTurnRefusalSchema = z.object({ error: z.string() });
export type ExtensionTurnCallAnswer = z.infer<typeof ExtensionTurnCallAnswerSchema>;

// POST /extension/jobs (2026-11-26): a background job filed in the calling conversation, as a `run_in_background`
// command's is: the agent's `wait` takes its id, the conversation's card lists it, `stop` ends it, and a turn ended on it
// is woken by its end. The extension's backend does the work; the daemon keeps the job's record, its place in a lane
// (`lane`: at most `most` of one lane at once, never two of one `key` at once, first come first served) and its end.
// Answered as an ndjson stream of ExtensionJobFrame, held open for as long as the job runs: the caller letting go of it
// before the job's end ends the job as failed.
export const EXTENSION_JOB_LANE_MOST = 8;
export const ExtensionJobStartSchema = z.object({
    turn: z.string().min(1),
    // How `wait` and the transcript name it.
    command: z.string().trim().min(1).max(400),
    // What the conversation's card shows.
    description: z.string().trim().min(1).max(200),
    // Its output until it ends: what it is doing, and what to do if a restart takes it down meanwhile.
    started: z.string().trim().min(1).max(4000),
    lane: z
        .object({
            name: z.string().trim().min(1).max(120),
            key: z.string().trim().min(1).max(400).optional(),
            most: z.number().int().min(1).max(EXTENSION_JOB_LANE_MOST).optional(),
        })
        .optional(),
});
export type ExtensionJobStart = z.infer<typeof ExtensionJobStartSchema>;
export const ExtensionJobFrameSchema = z.discriminatedUnion("kind", [
    // Filed: its id (what `wait` takes), its own ticket (what the job's work reaches the turn's grants and reports with)
    // and how many runs of its lane were ahead of it.
    z.object({ kind: z.literal("filed"), id: z.string().min(1), job: z.string().min(1), ahead: z.number().int().min(0) }),
    // Its turn in the lane came: do the work now.
    z.object({ kind: z.literal("begin") }),
    // Stopped by the agent or a person: its end is written, and what the work still does is read by nobody.
    z.object({ kind: z.literal("stopped") }),
    z.object({ kind: z.literal("heartbeat") }),
]);
export type ExtensionJobFrame = z.infer<typeof ExtensionJobFrameSchema>;

// POST /extension/jobs/{id}: a line onto what the job shows while it runs (`say`), or its end (`end`), told with the
// job's own ticket. The end's `output` is what `wait` and the wake hand the agent.
export const EXTENSION_JOB_LINE_MAX = 4000;
export const ExtensionJobReportSchema = z.object({
    job: z.string().min(1),
    say: z.string().max(EXTENSION_JOB_LINE_MAX).optional(),
    end: z.object({ ok: z.boolean(), output: z.string() }).optional(),
});
export type ExtensionJobReport = z.infer<typeof ExtensionJobReportSchema>;

// What an automation's fire carries to the handler it names (`api.automations.onFire`): the same `id` on every try, so a
// handler told twice (the daemon stopped before it heard the answer) can tell.
export const ExtensionFireSchema = z.object({
    id: z.string().min(1),
    automationId: z.string(),
    handler: z.string().regex(EXTENSION_FIRE_HANDLER),
    // When the automation fired (ms); a fire handed over late, after its backend was back, carries the moment it fired.
    firedAt: z.number(),
    // How many earlier fires of the same automation this one stands for: fired while the backend was down, and handed
    // over as one.
    coalesced: z.number().int().nonnegative(),
    // The trigger's payload (a webhook's body, a workspace event) and what the automation's check saw, when either was there.
    payload: z.string().optional(),
    observed: z.string().optional(),
    // The automation's own words (its `prompt`).
    prompt: z.string(),
});
export type ExtensionFire = z.infer<typeof ExtensionFireSchema>;

// (2026-11-26) One check of a watch kind the extension declares (`api.checks.serve`), as the daemon's automations engine
// hands it to the backend host's door: the source's parameters, what the last passing check saw, and the credential-gateway
// addresses of the extension's own cards the kind declares, as the automation's role reaches them, never a credential.
export const ExtensionWatchCheckSchema = z.object({
    // The kind's id, one the extension declares in `contributes.watchKinds`.
    kind: z.string().min(1),
    params: z.record(z.string(), z.union([z.string(), z.boolean()])),
    // What the last passing check saw, cut to the daemon's bound; absent before the first, and for a check tried by hand.
    last: z.string().optional(),
    // `<VARIABLE>_<CARD>` to a gateway address, the names a turn's shell would see them by.
    reach: z.record(z.string(), z.string()),
    // The automation it checks for; absent for a check tried by hand (the composer's Check now, a proposal's card).
    automationId: z.string().optional(),
});
export type ExtensionWatchCheck = z.infer<typeof ExtensionWatchCheckSchema>;

// What one check came to: it passes, with what it saw (what `fireOn: change` compares and the wake is told), or it does
// not, with what it is still waiting for in a sentence the run history shows.
export const ExtensionWatchAnswerSchema = z.discriminatedUnion("pass", [
    z.object({ pass: z.literal(true), output: z.string() }),
    z.object({ pass: z.literal(false), detail: z.string() }),
]);
export type ExtensionWatchAnswer = z.infer<typeof ExtensionWatchAnswerSchema>;

// (2026-11-26) WHO IS CALLING an extension's backend through /x/<id>, as the daemon verified it. The proxy strips every
// credential before it forwards, so a backend once heard a bare request; now the daemon attaches this assertion of the
// caller, minted for that one extension, signed with a key only the daemon holds in memory, and good for
// EXTENSION_CALLER_TTL_MS. The backend reads it (`api.caller(request)`), and POST /agent takes it back beside the
// extension's own token to start a turn as the person who pressed, held to that person's access as it stands then.
export const EXTENSION_CALLER_HEADER = "x-intentic-caller";
export const EXTENSION_CALLER_TTL_MS = 2 * 60_000;

// Who it is: a person signed in (their tier, the area ids their access holds and the workspace folders those come to, the
// parts of the sandbox they run), a repository's operator panel, a program holding a control token, another extension's
// backend, or nobody signed in at all, on a sandbox that runs without sign-in.
export const ExtensionCallerSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("person"),
        email: z.string(),
        name: z.string().optional(),
        tier: MemberTierSchema,
        areas: z.array(z.string()).optional(),
        // Workspace-relative folders this person may read; absent is the whole workspace, empty is none of it.
        folders: z.array(z.string()).optional(),
        manages: z.array(z.string()).optional(),
    }),
    z.object({ kind: z.literal("panel") }),
    z.object({ kind: z.literal("program"), id: z.string(), label: z.string() }),
    z.object({ kind: z.literal("extension"), id: z.string() }),
    z.object({ kind: z.literal("local") }),
]);
export type ExtensionCallerIdentity = z.infer<typeof ExtensionCallerSchema>;

// What the assertion carries, signed whole: the sandbox and the extension (its routing id) it was minted for, its
// window, a nonce, and the caller. `proof` is how a person proved who they are, which the daemon holds them to again
// when the assertion comes back.
export const ExtensionCallerClaimSchema = z.object({
    v: z.literal(1),
    sandbox: z.string(),
    extension: z.string(),
    issuedAt: z.number(),
    expiresAt: z.number(),
    nonce: z.string(),
    caller: ExtensionCallerSchema,
    proof: z.array(z.string()).optional(),
});
export type ExtensionCallerClaim = z.infer<typeof ExtensionCallerClaimSchema>;

// An assertion is `<base64url claim JSON>.<base64url signature>`; the claim reads without the key, the signature checks
// only with it.
export const readCallerClaim = (assertion: string): ExtensionCallerClaim | undefined => {
    const [encoded = "", signature = "", ...rest] = assertion.split(".");
    if (encoded === "" || signature === "" || rest.length > 0) {
        return undefined;
    }
    try {
        return ExtensionCallerClaimSchema.parse(JSON.parse(new TextDecoder().decode(base64UrlBytes(encoded))));
    } catch {
        // allow(silent-catch): an assertion that does not read is no caller, which the caller of this reports
        return undefined;
    }
};

const base64UrlBytes = (text: string): Uint8Array => {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

// (2026-11-26) A PUBLIC DOOR's request, as the backend hears it once the daemon's protections passed it
// (`contributes.publicRoutes`, served at /door/<id>/<path>): which declared route it landed on, the automation it is for,
// the Origin it was checked against or the door key that stood in, the signature scheme and the provider's delivery id,
// the caller a solved challenge was bound to, whether a Turnstile token passed, the caller's address as forwarded (advisory, never an identity), and when.
export const PUBLIC_DOOR_HEADER = "x-intentic-door";
export const PUBLIC_DOOR_POW_HEADER = "x-intentic-pow";
export const PUBLIC_DOOR_POW_CALLER_HEADER = "x-intentic-pow-caller";
export const PUBLIC_DOOR_KEY_PARAM = "key";
// GET /door/<id>/~challenge?caller=<id>: a proof-of-work challenge signed to that caller. No declared path can name it.
export const PUBLIC_DOOR_CHALLENGE = "~challenge";
export const PUBLIC_DOOR_CHALLENGE_PARAM = "caller";

// The signing schemes the daemon checks (the automations wire's own, which this list may not outgrow), spelled here so a
// process reading this subpath loads none of the automations schemas.
const DOOR_SIGNATURE_SCHEMES = ["github", "linear", "sentry", "stripe", "standard-webhooks"] as const satisfies readonly WebhookSignatureScheme[];

export const PublicDoorVerificationSchema = z.object({
    route: z.string(),
    automationId: z.string().optional(),
    origin: z.string().optional(),
    keyed: z.boolean().optional(),
    signature: z.object({ scheme: z.enum(DOOR_SIGNATURE_SCHEMES), deliveryId: z.string().optional() }).optional(),
    proofOfWork: z.object({ caller: z.string() }).optional(),
    // (2026-11-26) A Cloudflare Turnstile token the daemon verified with Cloudflare under the route's secret.
    turnstile: z.literal(true).optional(),
    remoteIp: z.string().optional(),
    at: z.number(),
});
export type PublicDoorVerification = z.infer<typeof PublicDoorVerificationSchema>;

// What the door header holds (base64url JSON), read back; undefined for anything else.
export const readPublicDoorVerification = (header: string | null | undefined): PublicDoorVerification | undefined => {
    if (header === undefined || header === null || header === "") {
        return undefined;
    }
    try {
        return PublicDoorVerificationSchema.parse(JSON.parse(new TextDecoder().decode(base64UrlBytes(header))));
    } catch {
        // allow(silent-catch): a header that does not read is no verification, which the caller of this refuses
        return undefined;
    }
};

// The public path a door answers at, from the extension's routing id and the route's own path.
export const publicDoorPath = (extension: string, path: string): string => `/door/${encodeURIComponent(extension)}/${path}`;

export const extensionSettingsUrl = (): string => rawRouteUrl("GET /extension/settings");
export const extensionEventsUrl = (): string => rawRouteUrl("GET /extension/events");
export const extensionWorkHoldUrl = (): string => rawRouteUrl("POST /extension/work/hold");
export const extensionExecUrl = (): string => rawRouteUrl("POST /extension/exec");
export const extensionBrowserUrl = (): string => rawRouteUrl("POST /extension/turn/browser");
export const extensionOwnerBrowserUrl = (): string => rawRouteUrl("POST /extension/turn/owner-browser");
export const extensionJobsUrl = (): string => rawRouteUrl("POST /extension/jobs");
export const extensionJobUrl = (id: string): string => rawRouteUrl("POST /extension/jobs/{id}", { id });

// What the daemon starts an extension's process with, and what `connectExtensionProcess` reads. The token is the same
// minted per-extension token its backend carries; the directories are the ones the backend api names.
export const EXTENSION_PROCESS_ENV = {
    daemon: "INTENTIC_DAEMON",
    token: "INTENTIC_EXTENSION_TOKEN",
    id: "INTENTIC_EXTENSION_ID",
    workspace: "INTENTIC_WORKSPACE",
    dir: "INTENTIC_EXTENSION_DIR",
    state: "INTENTIC_EXTENSION_STATE",
    cache: "INTENTIC_EXTENSION_CACHE",
    // The manifest's `permissions.daemon` as a JSON array, so a typed call outside it is refused before it is sent.
    permissions: "INTENTIC_EXTENSION_PERMISSIONS",
    // (2026-11-26) The rest of its `permissions` (events, work, exec, fires) as JSON, ExtensionDeclaredReachSchema: what the
    // runtime asks for on the event stream, and refuses before asking when undeclared. Absent: nothing declared.
    declared: "INTENTIC_EXTENSION_DECLARED",
} as const;

// What the permissions variable holds.
export const ExtensionPermissionsSchema = z.array(z.string());

// What the declared-reach variable holds (extension-manifest's ExtensionDeclaredReach).
export const ExtensionDeclaredReachSchema = z.object({
    events: z.array(ExtensionDeclaredEventSchema),
    work: z.boolean(),
    exec: z.array(ExtensionExecClassSchema),
    fires: z.array(z.string()),
    // (2026-11-26) Absent from a daemon before it: nothing declared.
    turn: z.array(ExtensionTurnPowerSchema).default([]),
});
