import { z } from "zod";
import { NeedsActionSchema } from "./needs-action.js";

/* THE RUNNER LINK'S EDGES: the handshake on /system/runners/connect, the env a runner boots with, and the
 * placement value a turn request carries. The procedures spoken over the link once it exists live in
 * contracts/runner.contract.ts; the design is docs/remote-runners-plan.md (workspace root).
 *
 * A runner is the sandbox image booted in runner mode: no browser owner, no tunnel, no public name. It dials
 * its PARENT sandbox and executes turns the parent dispatches; the parent keeps owning the conversation. The
 * host link (host-protocol.ts) is the pattern for everything here, one outbound socket that authenticates in
 * its first frame, because a runner sits behind the same NATs and private networks a laptop does. */

// The env the runner container boots with: who to dial, and the single-use pairing that gets it enrolled.
// Named here so `ic runner up`, the Fly provisioner and the daemon's boot detection spell them identically.
export const RUNNER_PARENT_URL_ENV = "RUNNER_PARENT_URL";
export const RUNNER_PAIR_TOKEN_ENV = "RUNNER_PAIR_TOKEN";

/* The first frame on /system/runners/connect, plain JSON, never oRPC, for host-protocol.ts's reason: a socket
 * must prove whose it is before a typed link attaches, and the proof cannot be a call on a link that does not
 * exist yet. The token rides the FRAME, never the URL (edge logs). */
export const RunnerHelloSchema = z.object({
    type: z.literal("runner-hello"),
    // The runner's durable token, redeemed once from the pairing over /system/runners/enroll.
    token: z.string(),
    // The daemon build the runner runs, surfaced per runner so an old image is visible rather than
    // mysteriously wrong.
    version: z.string(),
    /* Parity, reported rather than enforced: the parent knows what IT runs (image, channel, overlay hash) and
     * shows a runner that drifted as "outdated" with a rebuild action. An outdated runner still runs turns, a
     * stale toolchain is a fact the user can weigh, where a refusal would strand work. */
    image: z.string(),
    channel: z.string().optional(),
    overlayHash: z.string().optional(),
    /* The runner's DECLARED SHAPE, as the definition format spells it (definition.ts): a sandbox.toml whose
     * only populated section is settings, because that is all a runner declares — capabilities and secrets
     * never travel to one, and its repos are a mirror of the parent's git rather than clones with remotes.
     * The parent diffs this against its own settings to itemize drift (a stale toolchain is a rebuild; a
     * drifted setting is one applyDefinition call over this same socket), so parity stops being a bare
     * "outdated" and becomes lines naming what differs. Absent on an image too old to derive one. */
    definitionToml: z.string().optional(),
});
export type RunnerHello = z.infer<typeof RunnerHelloSchema>;

// The URL a runner dials, given its parent's public URL. One builder, so `ic`, the Fly provisioner and the
// daemon route cannot disagree about where the door is (hostConnectUrl's rule).
export const runnerConnectUrl = (parentUrl: string): string => `${parentUrl.replace(/^http/, "ws").replace(/\/$/, "")}/system/runners/connect`;

// Where a runner redeems its pairing for the durable token, once, over plain HTTPS.
export const runnerEnrollUrl = (parentUrl: string): string => `${parentUrl.replace(/\/$/, "")}/system/runners/enroll`;

/* The parent's git door for ONE repository: stock `git fetch`/`git push` against the smart-HTTP pair the
 * parent serves from its real git dirs (<historyRoot>/gits/<encoded id>), authenticated by the runner's own
 * token as a bearer. One builder because three parties spell it: the parent's route, the runner's sync, and
 * anyone debugging with a hand-typed clone. */
export const runnerGitUrl = (parentUrl: string, repo: string): string =>
    `${parentUrl.replace(/\/$/, "")}/system/runners/git/${encodeURIComponent(repo)}`;

/* Where a runner's push LANDS in the parent's git dirs. Never refs/heads/agent/<id> directly: that branch is
 * checked out in the parent's mirror worktree, and git itself refuses updating a checked-out ref, which is a
 * safety property worth keeping rather than configuring away. The parent moves the branch by hard-resetting
 * the mirror worktree to this ref, which advances the checked-out branch through the door git sanctions. */
export const runnerIncomingRef = (conversationId: string): string => `refs/runner-incoming/${conversationId}`;

/* THE CONTAINER A RUNNER'S NAME MEANS on the machine holding it, which is how the update and rebuild flows
 * address it. The prefix is `ic`'s own (runner.rs SLUG_PREFIX) and the two must stay identical: a mismatch
 * does not fail loudly, it sends an update at a container that does not exist and reports "no such sandbox"
 * about a runner sitting right there in the list. */
export const runnerSlug = (name: string): string => `runner-${name}`;

/* THE CREDENTIAL DOORS: a runner's turns spend the ORIGIN sandbox's model providers, never accounts of their
 * own. The shape is a service, not a sync: the parent resolves each turn's credential with the same code its
 * local turns use and answers with the least that travels — an access token minted for the turn, or a route.
 * Refresh tokens never leave the parent, which is what closes the rotation race two daemons refreshing one
 * account would otherwise run. Design: docs/remote-runners-plan.md §8 (workspace root). */
export const runnerCredentialsUrl = (parentUrl: string): string => `${parentUrl.replace(/\/$/, "")}/system/runners/credentials`;
export const runnerCredentialRefreshUrl = (parentUrl: string): string => `${parentUrl.replace(/\/$/, "")}/system/runners/credentials/refresh`;

/* The parent's model translator, re-served to runners: subscription-routed turns (codex/grok/kimi under the
 * Claude Code harness, OpenAI-protocol endpoints, the trial) authenticate against a translator whose auth
 * files live on the PARENT's /history. Rather than syncing those (the same rotation race), the runner's
 * harness dials this authenticated proxy and the parent forwards to its loopback translator. The bearer is
 * the runner's own token. */
export const runnerTranslatorPath = "/system/runners/translator";
export const runnerTranslatorUrl = (parentUrl: string): string => `${parentUrl.replace(/\/$/, "")}${runnerTranslatorPath}`;

export const RunnerCredentialRequestSchema = z.object({
    // The provider as the turn names it (absent = claude), an open vocabulary: endpoint/<id> included.
    agent: z.string().optional(),
    account: z.string().optional(),
    model: z.string().optional(),
});
export type RunnerCredentialRequest = z.infer<typeof RunnerCredentialRequestSchema>;

/* What travels back, by kind:
 *   oauth             — a native-Claude access token minted for this turn; `account` present when it is a
 *                       stored account (then the refresh door re-mints mid-turn), absent for the parent's
 *                       container-env fallback, which has nothing to rotate.
 *   parent-translator — run against the parent's translator through the proxy above; the runner supplies its
 *                       own token as the bearer (the parent never echoes a credential it only holds hashed).
 *   endpoint          — a foreign endpoint the runner can dial directly (an anthropic-protocol Endpoint
 *                       capability), with the bearer that endpoint wants.
 * A refusal is a value with the same codes local resolution uses, so the composer's connect gates read a
 * remote refusal exactly as a local one. */
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
    // The token the harness was refused with, so the parent's rotation supersedes exactly that one and a
    // token another turn already rotated is adopted, never re-refreshed (claude-credentials' own rule).
    rejected: z.string().min(1),
});
export type RunnerCredentialRefreshRequest = z.infer<typeof RunnerCredentialRefreshRequestSchema>;

// `accessToken` absent ⇒ the parent could not re-mint (a revoked account); the harness gives up exactly as a
// local turn whose refresh returned nothing does.
export const RunnerCredentialRefreshSchema = z.object({ accessToken: z.string().optional() });
export type RunnerCredentialRefresh = z.infer<typeof RunnerCredentialRefreshSchema>;

// What a runner is, hardware-wise: what the placement picker shows and what a future scheduler weighs.
export const RunnerFactsSchema = z.object({
    cpus: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
    freeDiskMb: z.number().int().nonnegative(),
    // 0..1 of the last minute, the coarse "is it busy" a picker needs, not a metrics feed.
    load: z.number().nonnegative(),
});
export type RunnerFacts = z.infer<typeof RunnerFactsSchema>;

/* WHETHER IT IS RUNNING WHAT THIS SANDBOX IS RUNNING (§7 of the design): `current` matches on image, channel
 * and approved overlay; `outdated` differs on one of them and gets the update button; `unknown` is a runner
 * that has never connected, or a parent that cannot name its own image (a dev daemon), where a warning would
 * be one nobody can act on. Reported, never enforced: an outdated runner still runs turns. */
export const RunnerParitySchema = z.enum(["current", "outdated", "unknown"]);
export type RunnerParity = z.infer<typeof RunnerParitySchema>;

// One runner as the owner's views list it: enrolled state plus whatever the hub knows right now, the
// HostSummary shape retold for a runner (no platform/scopes, parity instead).
export const RunnerSummarySchema = z.object({
    id: z.string(),
    // The connected computer holding it, when this sandbox is what asked for it (the Computers view's create
    // flow). Absent for one started by hand on a machine, which this sandbox can dispatch to but not manage.
    host: z.string().optional(),
    online: z.boolean(),
    version: z.string().optional(),
    image: z.string().optional(),
    channel: z.string().optional(),
    overlayHash: z.string().optional(),
    facts: RunnerFactsSchema.optional(),
    lastSeen: z.number().optional(),
    // Computed by the daemon (runners/runner-parity.ts) rather than by each surface, so the badge on a row and
    // the note in the placement picker cannot disagree about the same runner.
    parity: RunnerParitySchema,
    /* Where the runner's environment stands against this sandbox's, one line per difference (the definition
     * surface's drift unit, computed parent-side from the hello's definitionToml plus the overlay hashes).
     * Absent when the runner never said, empty when they agree. Lines whose subject is a Setting are fixable
     * over the live link (the sync door); an overlay line takes a rebuild. */
    drift: z.array(NeedsActionSchema).optional(),
});
export type RunnerSummary = z.infer<typeof RunnerSummarySchema>;

/* A workspace sync, narrated as it happens: a first contact clones whole repositories, and a person may be
 * watching the "preparing runner" state, so the lines travel while they are produced (runSandboxFlow's
 * argument). `op` says which direction: `pull` brings the runner's checkout of the conversation's branch (and
 * each repo's main line) up to date before a turn, `push` returns the branch after one.
 *
 * `repos` is the conversation's composition as the parent recorded it, because only the parent can know it:
 * the runner's own discovery would see whatever its mirror held from LAST time, and a repo added to the
 * workspace since would silently fall out of the conversation. Each entry names the repo id (the git-door
 * address), the workspace-relative dir the checkout lives at, and the repo's own main branch name. */
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

/* One turn, as dispatched. Deliberately NOT AgentTurnSchema: that schema is the browser's request to the
 * parent, full of fields the parent resolves before anything executes (persona, account, title, forks). What
 * crosses the link is the residue after resolution, what the runner's harness spawn actually needs, plus the
 * attachments inline, because the runner has no route onto the parent's attachment store. */
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
    // Which of the ORIGIN sandbox's connected accounts pays for the turn: the runner resolves credentials
    // against the parent (the credential doors below), so this names an account THERE.
    account: z.string().optional(),
    sessionId: z.string().optional(),
    // Base64 because frames are JSON: small by policy (the request schema already caps attachment count), and
    // a turn's attachments are the one payload with no git road to travel. `path` is the workspace-relative
    // path the prompt already names; the runner writes the bytes there so the words and the file agree.
    attachments: z.array(z.object({ path: z.string().min(1), bytesBase64: z.string() })).optional(),
});
export type RunnerTurn = z.infer<typeof RunnerTurnSchema>;

/* WHERE A CONVERSATION RUNS, decided on its first turn and owned by the conversation from then on, exactly as
 * `isolated` placement already works (agent.routes.ts): later turns follow the registry entry, not whichever
 * client sends them. `runner` implies isolation, a remote conversation is always branch-anchored, because its
 * branch is the unit that moves between machines. Absent means local, which is why this is optional
 * everywhere: the default costs nothing to anyone who never uses it. */
export const AgentPlacementSchema = z.union([z.object({ kind: z.literal("local") }), z.object({ kind: z.literal("runner"), id: z.string().min(1) })]);
export type AgentPlacement = z.infer<typeof AgentPlacementSchema>;
