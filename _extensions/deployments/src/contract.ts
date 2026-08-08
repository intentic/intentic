import { z } from "zod";

/* THE DEPLOYMENTS EXTENSION'S OWN WIRE SHAPES — shared by its two halves and by nobody else.
 *
 * This block used to live in @intentic/sandbox-contract as the core /komodo routes' schemas; it moved here
 * when the backend did. Zod only in this file (the UI half imports it and must not pull the oRPC contract
 * into the web bundle) — the route table over these shapes is src/server/contract.ts. */

// The daemon-proxied prefix the UI half calls — its own namespace, so no permissions.sandbox entry is needed.
// A literal rather than derived so the permissions conformance scanner (a regex over source) can resolve it.
export const DEPLOYMENTS_BASE = "/x/intentic.deployments";

/* ---- Komodo deployments: the Deployments rail view's wire shape ----
 *
 * The daemon does the VENDOR translation (Komodo's tagged unions and enums → the flat shapes below); the
 * extension does the ATTENTION model on top of them (which alerts are incidents, which have been seen, what
 * the rail says). Same split as CI, and for the same reason: what a breakage MEANS is a UI decision that has
 * to be unit-testable without a daemon, while what Komodo's `ContainerStateChange` variant looks like is a
 * detail no view should ever learn.
 *
 * Routes are per-connection (`/komodo/{capability}/…`): a sandbox can hold two Komodo capabilities, and the
 * credential the daemon resolves per call is the one the path names. The browser never holds either half of
 * the API key — that is the whole reason these routes exist rather than the view calling Komodo directly. */

// Every Komodo container state (DeploymentState ∪ StackState — eleven words between them) collapsed onto the
// five a view can tone. `stopped` swallows exited/stopped/paused/created/down/not_deployed on purpose: being
// down is a LEVEL and says nothing about whether it was meant to be. What says a running thing STOPPED is the
// alert log, which is why the badge reads alerts and this enum only colours a chip.
export const DeployStateSchema = z.enum(["running", "deploying", "stopped", "unhealthy", "unknown"]);
export type DeployState = z.infer<typeof DeployStateSchema>;

// Stacks and deployments are one row type in the view: a stack is a compose project, a deployment a single
// container, and an operator looking for what is down does not want them in separate lists.
const DeployResourceKindSchema = z.enum(["deployment", "stack"]);

// One service inside a stack — free of extra calls (Komodo's ListStacks already returns them under `info`),
// so a stack row can expand without a per-row fetch.
const DeployServiceSchema = z.object({
    name: z.string(),
    image: z.string(),
    updateAvailable: z.boolean(),
});

export const DeployResourceSchema = z.object({
    kind: DeployResourceKindSchema,
    // Komodo's resource id — what the action routes address (names collide across resource types, ids don't).
    id: z.string(),
    name: z.string(),
    state: DeployStateSchema,
    // Komodo's own status prose ("Up 4 days", "Exited (1) 20 minutes ago"). Passed through rather than
    // regenerated: docker's phrasing is more precise than anything we would compose from a state word.
    status: z.string().optional(),
    // The host it runs on — the grouping key of the whole view. Absent on a resource Komodo has not placed yet.
    server: z.string().optional(),
    image: z.string().optional(),
    // A newer image exists at the same tag. An opportunity, never a breakage — see the tone table in
    // ext-deployments' incidents.ts for why this may not reach the rail as `danger`.
    updateAvailable: z.boolean(),
    // Stacks only, and empty when the stack has none deployed yet.
    services: z.array(DeployServiceSchema),
    // Deep link into Komodo's own UI for this resource — we do not reimplement Komodo, we get you there.
    url: z.string(),
});
export type DeployResource = z.infer<typeof DeployResourceSchema>;

export const DeployServerStateSchema = z.enum(["ok", "unreachable", "disabled"]);
export type DeployServerState = z.infer<typeof DeployServerStateSchema>;

// A host, with the three gauges that explain a large share of deployment failures. All three ride ListServers'
// own `info.stats`, so the strip costs nothing extra; absent when the server is unreachable (no stats to have).
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

// One entry from Komodo's alert log — an EDGE, already timestamped and resolve-flagged server-side. This is
// what makes the rail badge possible without keeping any local history: Komodo records the transition, we only
// decide whether the owner has seen it. `type` stays the raw AlertData variant tag (ContainerStateChange,
// ServerUnreachable, DeploymentImageUpdateAvailable, BuildFailed…) — a variant we have not met yet is exactly
// the one worth surfacing, so it passes through instead of being dropped into an "other" bucket.
export const DeployAlertSchema = z.object({
    id: z.string(),
    type: z.string(),
    level: z.enum(["ok", "warning", "critical"]),
    // Komodo closes an alert when the condition clears; a resolved container-state alert IS the recovery.
    resolved: z.boolean(),
    // Epoch ms the alert OPENED — compared against seenAt, so further trouble inside one open alert can't re-badge.
    ts: z.number(),
    // The resource it is about, when the variant names one, and the host it sits on.
    resource: z.string().optional(),
    server: z.string().optional(),
    // The container/stack state transition, on the variants that carry one ("running" → "restarting").
    from: z.string().optional(),
    to: z.string().optional(),
});
export type DeployAlert = z.infer<typeof DeployAlertSchema>;

/* Who the API key acts as. Komodo filters EVERY list by the caller's permissions, so a key minted on a service
 * user with no grants returns 200 and an empty array — byte-identical to a Komodo with nothing deployed. That
 * ambiguity shipped once and cost a user an afternoon: their Komodo had four stacks and the board said "no
 * stacks or deployments yet". Carrying the viewer lets the empty state name the actual reason. */
const DeployViewerSchema = z.object({
    username: z.string(),
    // Either of Komodo's admin flags — an admin key sees everything, so its empty board really is empty.
    admin: z.boolean(),
});

/* A workspace repo that ships a compose file, and the Komodo stack it belongs to.
 *
 * Komodo names a stack whatever its creator typed; a repo names its compose project in the file. The two
 * usually agree, or nearly — `intentic` in the repo against `intentic-platform` in Komodo — so the daemon
 * SUGGESTS and the owner decides. The link is explicit and persisted because a guess that silently becomes a
 * fact is worse than no guess: the owner is the one who knows that `atlas` is this repo's staging stack. */
export const DeployRepoLinkSchema = z.object({
    // The workspace repo dir — the same `repo` key the rest of the app joins on.
    repo: z.string(),
    // The compose project name: the file's own `name:` when it has one, else the repo dir. This is what
    // `docker compose up` would call the project, so it is the best guess at the stack's name.
    projectName: z.string(),
    // Workspace-relative path of the compose file the name came from, so the UI can say where it looked.
    composePath: z.string(),
    // The stack the owner linked, once they have. Absent ⇒ unlinked, and `suggestions` is the offer.
    linkedStack: z.string().optional(),
    // Stack names that look like this repo, best first. Empty when nothing resembles it — in which case the
    // UI offers the full list rather than pretending it has an opinion.
    suggestions: z.array(z.string()),
});
export type DeployRepoLink = z.infer<typeof DeployRepoLinkSchema>;

// Link a repo to a stack, or clear the link with an empty `stack`. Explicit rather than a toggle: the owner
// may be replacing one stack with another, and a toggle cannot express that in one call.
export const DeployLinkParamSchema = z.object({
    capability: z.string(),
    repo: z.string(),
    stack: z.string(),
});

/* EVERY FIELD ADDED AFTER THIS ROUTE FIRST SHIPPED IS OPTIONAL OR DEFAULTED, and that is a rule rather than a
 * style. The browser validates this response with `.parse()`, and the daemon it is talking to is not
 * necessarily built from the same commit — a sandbox image is rebuilt on the owner's schedule, the web bundle
 * on ours. `repos` shipped REQUIRED and the first daemon that predated it took the whole view down with
 * `Invalid input: expected array, received undefined at repos`: not a missing band, a dead page, on the
 * surface whose entire job is to tell you whether production is up.
 *
 * So: a new field is `.default(...)` when the view can render without it, and `.optional()` when its absence
 * is itself meaningful. Neither is ever `required`. A newer browser must degrade against an older daemon. */
export const DeployOverviewResponseSchema = z.object({
    komodoUrl: z.string(),
    // FALSE means Komodo did not answer — the view says so loudly and the badge must not read `danger`.
    // "We cannot see production" is not "production is broken", the same line ciAttention draws when it
    // leaves the last known state standing rather than blanking the tile.
    reachable: z.boolean(),
    // Why it did not answer, in Komodo's own words — the view shows it instead of a bare "unavailable".
    unreachableReason: z.string().optional(),
    // Absent when Komodo did not answer — or when the daemon predates the field, which the empty state has to
    // tell apart from "the key sees nothing", since only one of those is the owner's to fix.
    viewer: DeployViewerSchema.optional(),
    // Every workspace repo with a compose file, with its suggested or linked stack. Independent of whether
    // Komodo returned anything: a repo the owner could link is worth showing even on an empty board, since
    // that is exactly the moment they need to know what this view is for.
    repos: z.array(DeployRepoLinkSchema).default([]),
    resources: z.array(DeployResourceSchema),
    servers: z.array(DeployServerSchema),
    // Newest first. Unresolved and resolved both: the view shows recent history, the badge reads only the
    // unresolved half.
    alerts: z.array(DeployAlertSchema),
    // When the owner last opened THIS connection's view. Rides the response so the rail decides what is new
    // without a second call. Absent ⇒ never opened, so everything counts as unseen.
    seenAt: z.number().optional(),
});
export type DeployOverviewResponse = z.infer<typeof DeployOverviewResponseSchema>;

// Which Komodo connection a call addresses — the capability id, which is also the rail tile's key.
export const DeployCapabilityParamSchema = z.object({ capability: z.string() });

// The five state-changing operations the view offers. Deliberately no `write/*`: editing config from a
// dashboard is how you get drift the desired-state repo then fights, so configuration stays in Komodo or in
// the intent repo. `pull` pulls the newest image AND deploys — the routine version bump as one click.
export const DeployActionSchema = z.enum(["deploy", "restart", "start", "stop", "pull"]);
export type DeployAction = z.infer<typeof DeployActionSchema>;

export const DeployActionParamSchema = z.object({
    capability: z.string(),
    kind: DeployResourceKindSchema,
    // Komodo's resource id. Re-resolved to a live resource per call, so a stale card cannot act on something
    // that has since been deleted — the CI actions' "re-resolve per call" rule.
    id: z.string(),
    action: DeployActionSchema,
});

export const DeployLogsParamSchema = z.object({
    capability: z.string(),
    kind: DeployResourceKindSchema,
    id: z.string(),
});

// Komodo returns a `Log` with both channels; the view renders them together, newest at the bottom, the way a
// terminal would.
export const DeployLogsResponseSchema = z.object({ stdout: z.string(), stderr: z.string() });
export type DeployLogsResponse = z.infer<typeof DeployLogsResponseSchema>;

// The fix route opens an isolated conversation seeded with the resource, its state, and its log tail — the
// thing Komodo's own UI structurally cannot do, since the repo that holds the bug is open in the next tab.
export const DeployFixResponseSchema = z.object({ conversationId: z.string() });
export type DeployFixResponse = z.infer<typeof DeployFixResponseSchema>;

export const DeploySeenResponseSchema = z.object({ seenAt: z.number() });
