import { z } from "zod";
import { NeedsActionSchema } from "../policy/needs-action.js";

// The runner link's edges: the /system/runners/connect handshake, boot env, and turn placement (procedures live in
// contracts/runner.contract.ts). A runner is a sandbox image in runner mode, no browser owner or tunnel, that dials its
// parent over one outbound socket authenticating in its first frame.

// Boot env for a runner container: who to dial, and the single-use pairing token to enroll with.
export const RUNNER_PARENT_URL_ENV = "RUNNER_PARENT_URL";
export const RUNNER_PAIR_TOKEN_ENV = "RUNNER_PAIR_TOKEN";

// First frame on /system/runners/connect: plain JSON, not oRPC, since a socket must prove whose it is before a typed
// link exists. Token rides the frame, never the URL.
export const RunnerHelloSchema = z.object({
    type: z.literal("runner-hello"),
    // The runner's durable token, redeemed once from the pairing over /system/runners/enroll.
    token: z.string(),
    // The daemon build the runner runs, so an old image is visible rather than mysteriously wrong.
    version: z.string(),
    // Compared against what the parent runs to report parity (outdated → rebuild action); an outdated runner still runs
    // turns rather than being refused.
    image: z.string(),
    channel: z.string().optional(),
    overlayHash: z.string().optional(),
    // Runner's declared settings-only sandbox.toml (definition.ts), diffed against the parent's to itemize drift;
    // absent on an old image.
    definitionToml: z.string().optional(),
});
export type RunnerHello = z.infer<typeof RunnerHelloSchema>;

// The URL a runner dials, given its parent's public URL. One builder, so `ic`, the Fly provisioner and the
// daemon route cannot disagree about where the door is (hostConnectUrl's rule).
/* HOW OFTEN THE PARENT PINGS A CONNECTED RUNNER, read by both sides of the socket: the parent's hub pings on
 * it (runners/runner-peer.ts) and the runner presumes the link dead after a few of them pass in silence
 * (peer-dial.ts's peerLinkSilenceMs). One number, because the two sides disagreeing about it is a runner either
 * dropped while healthy or believed alive for as long as its socket happens to stay open. */
export const RUNNER_HEARTBEAT_MS = 30_000;

export const runnerConnectUrl = (parentUrl: string): string => `${parentUrl.replace(/^http/, "ws").replace(/\/$/, "")}/system/runners/connect`;

// Where a runner redeems its pairing for a durable token, once, over plain HTTPS.
export const runnerEnrollUrl = (parentUrl: string): string => `${parentUrl.replace(/\/$/, "")}/system/runners/enroll`;

// The parent's git door for one repo: stock git fetch/push against its smart-HTTP git dirs, authenticated by the
// runner's own token as bearer.
export const runnerGitUrl = (parentUrl: string, repo: string): string =>
    `${parentUrl.replace(/\/$/, "")}/system/runners/git/${encodeURIComponent(repo)}`;

// Where a runner's push lands; never refs/heads/agent/<id> directly since git refuses updating a checked-out ref. The
// parent advances that branch by hard-resetting its mirror worktree to this ref.
export const runnerIncomingRef = (conversationId: string): string => `refs/runner-incoming/${conversationId}`;

// Container name for a runner on its host machine; the `ic`-prefix (runner.rs SLUG_PREFIX) must match exactly, or
// updates target a container that doesn't exist.
export const runnerSlug = (name: string): string => `runner-${name}`;

// Credential doors: a runner's turns spend the origin sandbox's model providers, never accounts of its own. The parent
// answers with the least that travels (a minted token or a route); refresh tokens never leave it.
export const runnerCredentialsUrl = (parentUrl: string): string => `${parentUrl.replace(/\/$/, "")}/system/runners/credentials`;
export const runnerCredentialRefreshUrl = (parentUrl: string): string => `${parentUrl.replace(/\/$/, "")}/system/runners/credentials/refresh`;

// Re-serves the parent's model translator to runners: subscription-routed turns dial this authenticated proxy instead
// of syncing auth files, and the parent forwards to its own loopback translator.
export const runnerTranslatorPath = "/system/runners/translator";
export const runnerTranslatorUrl = (parentUrl: string): string => `${parentUrl.replace(/\/$/, "")}${runnerTranslatorPath}`;

export const RunnerCredentialRequestSchema = z.object({
    // Provider as the turn names it (absent = claude); an open vocabulary, including endpoint/<id>.
    agent: z.string().optional(),
    account: z.string().optional(),
    model: z.string().optional(),
});
export type RunnerCredentialRequest = z.infer<typeof RunnerCredentialRequestSchema>;

// What travels back, by kind:
// oauth: a native-Claude access token minted for this turn; `account` set for a stored account, absent for the
// container-env fallback
// parent-translator: runs against the parent's translator through the proxy; the runner supplies its own token as
// bearer
// endpoint: a foreign endpoint capability the runner dials directly, with its own bearer
// A refusal uses the same codes as local resolution, so a remote refusal reads like a local one.
export const RunnerCredentialSchema = z.union([
    z.object({ ok: z.literal(true), kind: z.literal("oauth"), accessToken: z.string(), account: z.string().optional() }),
    z.object({ ok: z.literal(true), kind: z.literal("parent-translator"), model: z.string(), trial: z.boolean().optional() }),
    z.object({
        ok: z.literal(true),
        kind: z.literal("endpoint"),
        baseUrl: z.string(),
        authToken: z.string(),
        model: z.string(),
        trial: z.boolean().optional(),
    }),
    z.object({
        ok: z.literal(false),
        code: z.enum(["subscription-required", "claude-reauth", "trial-unavailable"]).optional(),
        message: z.string(),
    }),
]);
export type RunnerCredential = z.infer<typeof RunnerCredentialSchema>;

export const RunnerCredentialRefreshRequestSchema = z.object({
    account: z.string().min(1),
    // Token the harness was refused with; rotation supersedes exactly that one, never a token already rotated.
    rejected: z.string().min(1),
});
export type RunnerCredentialRefreshRequest = z.infer<typeof RunnerCredentialRefreshRequestSchema>;

// Absent `accessToken` means the parent couldn't re-mint (a revoked account); the harness gives up as it would locally.
export const RunnerCredentialRefreshSchema = z.object({ accessToken: z.string().optional() });
export type RunnerCredentialRefresh = z.infer<typeof RunnerCredentialRefreshSchema>;

// What a runner is, hardware-wise: what the placement picker shows and a future scheduler would weigh.
export const RunnerFactsSchema = z.object({
    cpus: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
    freeDiskMb: z.number().int().nonnegative(),
    // 0..1 over the last minute; a coarse busy signal for a picker, not a metrics feed.
    load: z.number().nonnegative(),
});
export type RunnerFacts = z.infer<typeof RunnerFactsSchema>;

// Whether a runner matches this sandbox's image, channel and approved overlay: `current`, `outdated` (gets an update
// button), or `unknown` (never connected, or a parent that can't name its own image). Reported, never enforced.
export const RunnerParitySchema = z.enum(["current", "outdated", "unknown"]);
export type RunnerParity = z.infer<typeof RunnerParitySchema>;

// One runner as the owner's list shows it: enrolled state plus whatever the hub currently knows — HostSummary's shape,
// retold with parity instead of platform/scopes.
export const RunnerSummarySchema = z.object({
    id: z.string(),
    // The connected device that requested it (Devices view); absent for one started by hand on a machine.
    host: z.string().optional(),
    online: z.boolean(),
    version: z.string().optional(),
    image: z.string().optional(),
    channel: z.string().optional(),
    overlayHash: z.string().optional(),
    facts: RunnerFactsSchema.optional(),
    lastSeen: z.number().optional(),
    // Computed once by the daemon (runners/runner-parity.ts), so every surface shows the same badge.
    parity: RunnerParitySchema,
    // Where the runner's environment differs from this sandbox's, one line per difference; absent if never reported,
    // empty if they agree. A Setting line is fixable live; an overlay line needs a rebuild.
    drift: z.array(NeedsActionSchema).optional(),
});
export type RunnerSummary = z.infer<typeof RunnerSummarySchema>;

// A workspace sync, narrated line by line as it happens (first contact clones whole repos). `op`: `pull` brings the
// runner's checkout current before a turn, `push` returns the branch after; `repos` is the parent's own record, since
// the runner's mirror could be stale.
export const RunnerSyncSchema = z.object({
    op: z.enum(["pull", "push"]),
    conversationId: z.string().min(1),
    branch: z.string().min(1),
    repos: z.array(
        z.object({
            repo: z.string().min(1),
            // "" for the workspace root itself; every other repo sits at its root-relative dir.
            dir: z.string(),
            mainBranch: z.string().min(1),
        }),
    ),
});
export type RunnerSync = z.infer<typeof RunnerSyncSchema>;

export const RunnerSyncLineSchema = z.union([
    z.object({ kind: z.literal("line"), text: z.string() }),
    z.object({ kind: z.literal("done"), ok: z.boolean(), detail: z.string().optional() }),
]);
export type RunnerSyncLine = z.infer<typeof RunnerSyncLineSchema>;

// One dispatched turn, not AgentTurnSchema: that's the browser's request full of fields the parent resolves first. This
// is the residue after resolution, plus attachments inline, since the runner has no route to the parent's attachment
// store.
export const RunnerTurnSchema = z.object({
    conversationId: z.string().min(1),
    branch: z.string().min(1),
    prompt: z.string(),
    provider: z.string(),
    harness: z.string(),
    model: z.string().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
    fast: z.boolean().optional(),
    // Which origin-sandbox account pays; credentials resolve against the parent, naming an account there.
    account: z.string().optional(),
    sessionId: z.string().optional(),
    // Base64 since frames are JSON and attachment count is capped; `path` is the workspace-relative path the prompt
    // already names.
    attachments: z.array(z.object({ path: z.string().min(1), bytesBase64: z.string() })).optional(),
});
export type RunnerTurn = z.infer<typeof RunnerTurnSchema>;

// Where a conversation runs, fixed on its first turn like `isolated` placement: later turns follow the registry, not
// the sender. `runner` implies isolation since a remote conversation is branch-anchored; absent means local.
export const AgentPlacementSchema = z.union([z.object({ kind: z.literal("local") }), z.object({ kind: z.literal("runner"), id: z.string().min(1) })]);
export type AgentPlacement = z.infer<typeof AgentPlacementSchema>;
