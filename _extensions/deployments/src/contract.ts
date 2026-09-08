import { AgentRunPickSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

// The deployments extension's own wire shapes, shared by its UI and server halves, used by nobody else. Zod only lives
// here: the UI half imports it and must not pull the oRPC contract into the web bundle. Route table for these shapes is
// in server/contract.ts.

// Own namespace, no permissions.sandbox entry needed; kept literal so the conformance scanner can resolve it.
export const DEPLOYMENTS_BASE = "/x/intentic.deployments";

// Komodo deployments: the daemon does vendor translation (Komodo's shapes to the flat ones below); the extension layers
// an attention model on top, unit-testable without a daemon. Routes are per-connection; the browser never holds the
// Komodo API key itself.

// Collapses Komodo's ~11 states onto 5; `stopped` is a level only, transitions live in the alert log instead.
export const DeployStateSchema = z.enum(["running", "deploying", "stopped", "unhealthy", "unknown"]);
export type DeployState = z.infer<typeof DeployStateSchema>;

// Stack and deployment share one row type: an operator scanning for what's down wants one list, not two.
const DeployResourceKindSchema = z.enum(["deployment", "stack"]);

// One service inside a stack; rides Komodo's ListStacks response, so expanding a stack needs no extra fetch.
const DeployServiceSchema = z.object({
    name: z.string(),
    image: z.string(),
    updateAvailable: z.boolean(),
});

export const DeployResourceSchema = z.object({
    kind: DeployResourceKindSchema,
    // Komodo's resource id; action routes address by id since names collide across resource types.
    id: z.string(),
    name: z.string(),
    state: DeployStateSchema,
    // Komodo's own status prose, passed through; more precise than anything composed from the state word.
    status: z.string().optional(),
    // Host it runs on; the view's grouping key. Absent when Komodo hasn't placed the resource yet.
    server: z.string().optional(),
    image: z.string().optional(),
    // A newer image at the same tag; an opportunity, not a breakage, so it never tones the rail `danger`.
    updateAvailable: z.boolean(),
    // Stacks only; empty when the stack has nothing deployed yet.
    services: z.array(DeployServiceSchema),
    // Deep link into Komodo's own UI for this resource, rather than reimplementing it here.
    url: z.string(),
});
export type DeployResource = z.infer<typeof DeployResourceSchema>;

export const DeployServerStateSchema = z.enum(["ok", "unreachable", "disabled"]);
export type DeployServerState = z.infer<typeof DeployServerStateSchema>;

// Host plus its three gauges; ride ListServers' own info.stats, so the strip costs nothing extra.
export const DeployServerSchema = z.object({
    id: z.string(),
    name: z.string(),
    state: DeployServerStateSchema,
    cpuPercent: z.number().optional(),
    memPercent: z.number().optional(),
    diskPercent: z.number().optional(),
    url: z.string(),
});
export type DeployServer = z.infer<typeof DeployServerSchema>;

// One alert entry, already timestamped/resolved; `type` keeps Komodo's raw tag so new variants still surface.
export const DeployAlertSchema = z.object({
    id: z.string(),
    type: z.string(),
    level: z.enum(["ok", "warning", "critical"]),
    // Komodo closes an alert once the condition clears; a resolved container-state alert is the recovery.
    resolved: z.boolean(),
    // Epoch ms the alert opened; compared against seenAt so ongoing trouble in one alert doesn't re-badge.
    ts: z.number(),
    // Resource the alert is about, when the variant names one, and the host it runs on.
    resource: z.string().optional(),
    server: z.string().optional(),
    // State transition, on variants that carry one; absent otherwise.
    from: z.string().optional(),
    to: z.string().optional(),
});
export type DeployAlert = z.infer<typeof DeployAlertSchema>;

// Who the API key acts as; Komodo filters lists by permission, so empty could mean no access, not emptiness.
const DeployViewerSchema = z.object({
    username: z.string(),
    // Either of Komodo's admin flags; an admin key sees everything, so its empty board really is empty.
    admin: z.boolean(),
});

// Workspace repo with a compose file, and the Komodo stack it maps to; the daemon suggests, owner confirms.
export const DeployRepoLinkSchema = z.object({
    // Workspace repo dir; the same `repo` key the rest of the app joins on.
    repo: z.string(),
    // Compose project name: the file's `name:` if set, else the repo dir; what `docker compose up` would call it.
    projectName: z.string(),
    // Workspace-relative path of the compose file the name came from, so the UI can say where it looked.
    composePath: z.string(),
    // Stack the owner linked, once they have; absent means unlinked, with `suggestions` as the offer.
    linkedStack: z.string().optional(),
    // Stack names resembling this repo, best first; empty means the UI offers the full list instead.
    suggestions: z.array(z.string()),
});
export type DeployRepoLink = z.infer<typeof DeployRepoLinkSchema>;

// Links a repo to a stack, or clears with empty `stack`; a toggle can't express swapping stacks.
export const DeployLinkParamSchema = z.object({
    capability: z.string(),
    repo: z.string(),
    stack: z.string(),
});

// Fields added after this route shipped are optional or defaulted, never required, since browser and daemon can be on
// different commits. Default when the view renders fine without it; optional when absence itself is meaningful.
export const DeployOverviewResponseSchema = z.object({
    komodoUrl: z.string(),
    // False means Komodo didn't answer; not seeing it isn't the same as it being broken, so never `danger`.
    reachable: z.boolean(),
    // Why it didn't answer, in Komodo's own words; shown instead of a bare "unavailable".
    unreachableReason: z.string().optional(),
    // Absent when Komodo didn't answer or the daemon predates the field; distinct from "the key sees nothing".
    viewer: DeployViewerSchema.optional(),
    // Every workspace repo with a compose file; shown even on an empty board, when linking one matters most.
    repos: z.array(DeployRepoLinkSchema).default([]),
    resources: z.array(DeployResourceSchema),
    servers: z.array(DeployServerSchema),
    // Newest first, resolved and unresolved both; the badge reads only the unresolved half.
    alerts: z.array(DeployAlertSchema),
    // Last time the owner opened this connection's view, so the rail needs no second call; absent = never opened.
    seenAt: z.number().optional(),
});
export type DeployOverviewResponse = z.infer<typeof DeployOverviewResponseSchema>;

// Which Komodo connection a call addresses: the capability id, same as the rail tile's key.
export const DeployCapabilityParamSchema = z.object({ capability: z.string() });

// No `write/*` here: it would drift against the desired-state repo; `pull` fetches and deploys in one click.
export const DeployActionSchema = z.enum(["deploy", "restart", "start", "stop", "pull"]);
export type DeployAction = z.infer<typeof DeployActionSchema>;

export const DeployActionParamSchema = z.object({
    capability: z.string(),
    kind: DeployResourceKindSchema,
    // Komodo's resource id; re-resolved per call so a stale card can't act on something already deleted.
    id: z.string(),
    action: DeployActionSchema,
});

export const DeployLogsParamSchema = z.object({
    capability: z.string(),
    kind: DeployResourceKindSchema,
    id: z.string(),
});

// Adds which model to run on, when the reader used the caret; absent falls back to the usual agent-run list.
export const DeployFixParamSchema = DeployLogsParamSchema.extend({ pick: AgentRunPickSchema });

// Komodo returns both channels; the view renders them together, newest at the bottom, like a terminal.
export const DeployLogsResponseSchema = z.object({ stdout: z.string(), stderr: z.string() });
export type DeployLogsResponse = z.infer<typeof DeployLogsResponseSchema>;

// Opens an isolated conversation seeded with the resource, state, and log tail; Komodo's UI can't do this.
export const DeployFixResponseSchema = z.object({ conversationId: z.string() });
export type DeployFixResponse = z.infer<typeof DeployFixResponseSchema>;

export const DeploySeenResponseSchema = z.object({ seenAt: z.number() });
