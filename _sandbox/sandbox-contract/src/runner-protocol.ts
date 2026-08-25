import { z } from "zod";

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
});
export type RunnerHello = z.infer<typeof RunnerHelloSchema>;

// The URL a runner dials, given its parent's public URL. One builder, so `ic`, the Fly provisioner and the
// daemon route cannot disagree about where the door is (hostConnectUrl's rule).
export const runnerConnectUrl = (parentUrl: string): string => `${parentUrl.replace(/^http/, "ws").replace(/\/$/, "")}/system/runners/connect`;

// What a runner is, hardware-wise: what the placement picker shows and what a future scheduler weighs.
export const RunnerFactsSchema = z.object({
    cpus: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
    freeDiskMb: z.number().int().nonnegative(),
    // 0..1 of the last minute, the coarse "is it busy" a picker needs, not a metrics feed.
    load: z.number().nonnegative(),
});
export type RunnerFacts = z.infer<typeof RunnerFactsSchema>;

// One runner as the owner's views list it: enrolled state plus whatever the hub knows right now, the
// HostSummary shape retold for a runner (no platform/scopes, parity instead).
export const RunnerSummarySchema = z.object({
    id: z.string(),
    online: z.boolean(),
    version: z.string().optional(),
    image: z.string().optional(),
    channel: z.string().optional(),
    overlayHash: z.string().optional(),
    facts: RunnerFactsSchema.optional(),
    lastSeen: z.number().optional(),
});
export type RunnerSummary = z.infer<typeof RunnerSummarySchema>;

/* A workspace sync, narrated as it happens: a first contact clones whole repositories, and a person may be
 * watching the "preparing runner" state, so the lines travel while they are produced (runSandboxFlow's
 * argument). `op` says which direction: `pull` brings the conversation's branch up to date before a turn,
 * `push` returns the result after one. */
export const RunnerSyncSchema = z.object({
    op: z.enum(["pull", "push"]),
    conversationId: z.string().min(1),
    branch: z.string().min(1),
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
    sessionId: z.string().optional(),
    // Base64 because frames are JSON: small by policy (the request schema already caps attachment count), and
    // a turn's attachments are the one payload with no git road to travel.
    attachments: z.array(z.object({ path: z.string().min(1), bytesBase64: z.string() })).optional(),
});
export type RunnerTurn = z.infer<typeof RunnerTurnSchema>;

/* WHERE A CONVERSATION RUNS, decided on its first turn and owned by the conversation from then on, exactly as
 * `isolated` placement already works (agent.routes.ts): later turns follow the registry entry, not whichever
 * client sends them. `runner` implies isolation, a remote conversation is always branch-anchored, because its
 * branch is the unit that moves between machines. Absent means local, which is why this is optional
 * everywhere: the default costs nothing to anyone who never uses it. */
export const AgentPlacementSchema = z.union([
    z.object({ kind: z.literal("local") }),
    z.object({ kind: z.literal("runner"), id: z.string().min(1) }),
]);
export type AgentPlacement = z.infer<typeof AgentPlacementSchema>;
