import type { RouteMeta } from "./route-meta.js";
import type { ContractRoute } from "./routes.js";
import { runnerTranslatorPath } from "./runner-protocol.js";

// Every route the daemon serves outside oRPC (streamed bytes, WebSocket upgrades, doors checking their own credential),
// keyed `METHOD /path` in the order the daemon registers them: among overlapping ones the first registered answers.
// `{param}` is one path segment, a trailing `/*` any further ones, `ALL` every method; the daemon serves no other.
export const RAW_ROUTES = {
    // The "is a daemon there" probe every flow uses; it names the sandbox and says whether it is still converging.
    "GET /health": { auth: "door", beforeBoot: true },
    "GET /diff/raw": { lane: "bulk" },
    // Arming the dictation model is a read any tier makes; dictating is writing a message, the collaborator's grant.
    "GET /speech/status": { guest: true },
    "POST /speech/transcribe": { floor: "collaborator", guest: true },
    // The bytes behind the workspace reads; each applies the caller's fence itself.
    "GET /workspace/raw": { guest: true, lane: "bulk" },
    // No door, unlike media: the page fetches a thumbnail itself, so the request carries the header.
    "GET /workspace/thumb": { guest: true },
    // Fetched by a <video>/<audio> tag, which sends no header: its scoped ticket is checked in the handler.
    "GET /workspace/media": { auth: "door", guest: true, lane: "bulk" },
    // An attachment is part of the message it rides with; any other target edits the shared tree.
    "POST /workspace/upload": { floor: "writer", attachmentFloor: "collaborator", lane: "bulk" },
    "POST /workspace/upload-diff": {},
    "POST /workspace/upload-archive": { lane: "bulk" },
    // Minting is cheap: each WebSocket upgrade floors its own redemption.
    "POST /system/ws-ticket": { beforeBoot: true, floor: "collaborator", control: "never" },
    // A WebSocket upgrade carries no Authorization header; the terminal and both browser wires check a query ticket.
    "GET /system/terminal": { auth: "door", beforeBoot: true, control: "never", front: true },
    // Desktop sync's byte pipe, guarded again by sshd's own key check against the same enrollment.
    "GET /system/sync/ssh": { sync: "pipe", control: "never", lane: "bulk" },
    "GET /system/browser-profile": { auth: "door", beforeBoot: true, control: "never" },
    "GET /system/browser-view": { auth: "door", beforeBoot: true, control: "never" },
    // Deploy-target enrollment, gated by the connect token.
    "POST /enroll": { auth: "door", control: "never" },
    // An event automation's webhook, gated by the automation's own token.
    "POST /automations/{id}/fire": { auth: "door" },
    // The release gate a pipeline runner waits on, gated by the workflow's minted gate token.
    "POST /workflows/{id}/gate": { auth: "door" },
    // The Visitor chat, embedded on the owner's sites: gated by its origin allowlist, rate limit and bot check.
    "GET /webchat/widget.js": { auth: "door", embedded: true },
    "GET /webchat/{id}/config": { auth: "door", embedded: true },
    "GET /webchat/{id}/challenge": { auth: "door", embedded: true },
    "POST /webchat/{id}/message": { auth: "door", embedded: true },
    "GET /webchat/{id}/messages": { auth: "door", embedded: true },
    // Which sites loaded the widget is the owner's diagnostic, not the visitor's.
    "GET /webchat/{id}/installs": {},
    // The bug intake, the other anonymous door: gated by origin allowlist or ingest key, rate window and daily ceiling.
    "GET /intake/sdk.js": { auth: "door", embedded: true },
    "GET /intake/{id}/config": { auth: "door", embedded: true },
    "GET /intake/{id}/challenge": { auth: "door", embedded: true },
    "POST /intake/{id}/report": { auth: "door", embedded: true },
    // The roster is ownership's to change; giving up one's own grant is every tier's.
    "GET /members": { control: "never" },
    "POST /members": { control: "never" },
    "DELETE /members": { control: "never" },
    "DELETE /members/self": { floor: "viewer", guest: true, control: "never" },
    "GET /environment": {},
    "GET /environment/contents": {},
    "POST /environment/approve": {},
    "POST /environment/reject": {},
    "POST /environment/runtime-install": {},
    "GET /engines": {},
    "POST /engines/channel": {},
    "POST /engines/update": {},
    "POST /engines/revert": {},
    "GET /bundles": { control: "never" },
    "POST /bundles": { control: "never" },
    "DELETE /bundles": { control: "never" },
    "POST /bundles/ticket": { control: "never" },
    // Navigated to by the browser, so no header: its ticket is checked in the handler.
    "GET /bundles/download": { auth: "door", control: "never", lane: "bulk" },
    "GET /definition": {},
    "POST /definition/diff": {},
    "GET /definition/workspace": {},
    "POST /definition/workspace/publish": {},
    "POST /arrivals/plan": {},
    "GET /arrivals/hosts": {},
    "POST /arrivals/scan": {},
    "POST /arrivals/apply": {},
    "DELETE /arrivals": {},
    "GET /extensions/{id}/bundle": { lane: "bulk" },
    // An extension backend's own namespace, proxied verbatim.
    "ALL /x/*": {},
    // Every MCP server the daemon hosts for a turn (its browser routers, the machines and browsers it was granted, its
    // extension cards' endpoints), by server name: the handler checks the conversation's mount bearer the turn's tool
    // config carries, and that the running turn mounted that name.
    "ALL /mcp/{mount}": { auth: "door", control: "never" },
    // The `capabilities` CLI: discovery by name, and the ask that parks on an owner-decided card.
    "GET /capabilities/connectable": { floor: "maintainer", agent: true, control: "never" },
    "POST /capabilities/ask": { floor: "maintainer", agent: true, control: "never" },
    // The `sandboxes` CLI; every create parks on a card in the owner's chat first.
    "GET /sandboxes": { agent: true },
    "POST /sandboxes": { agent: true },
    // The `wallet` CLI; spend is bounded by the owner's policy and the key never enters the container.
    "GET /wallet/status": { agent: true, control: "never" },
    "POST /wallet/fetch": { agent: true, control: "never" },
    "GET /wallet/history": { agent: true, control: "never" },
    // The `agents` CLI's children: start, follow up, answer (never a consent card), list.
    "POST /children/spawn": { agent: true, control: "never" },
    "GET /children/providers": { agent: true, control: "never" },
    "POST /children/wait": { agent: true, control: "never" },
    "POST /children/send": { agent: true, control: "never" },
    "POST /children/answer": { agent: true, control: "never" },
    "GET /children": { agent: true, control: "never" },
    // The fleet reads, and the one write: words in front of another conversation, which a person can do by typing.
    "GET /fleet": { agent: true },
    "POST /fleet/message": { agent: true },
    "GET /fleet/{handle}": { agent: true },
    // An extension gateway's realtime-listener control: /state hands back its connectors' stored credentials, so only the
    // extension token of the extension declaring that `listener.provider` reaches them, checked in the handler too.
    "GET /listeners/{provider}/state": { floor: "maintainer", panel: false, control: "never" },
    "POST /listeners/{provider}/dispatch": { panel: false, control: "never" },
    "POST /listeners/{provider}/failure": { panel: false, control: "never" },
    "POST /listeners/{provider}/status": { panel: false, control: "never" },
    // The CI webhook receiver, gated by the per-sandbox webhook secret.
    "POST /ci/webhook/{host}": { auth: "door" },
    // Below maintainer a pairing is capped to port-mirror, so a collaborator may mint a preview tunnel.
    "POST /system/sync/pair": { floor: "collaborator", control: "never" },
    // The peer doors: a device, browser or runner redeems its pairing at `enroll` and dials `connect` with the token.
    "POST /system/hosts/pair": { control: "never" },
    "POST /system/hosts/enroll": { auth: "door", control: "never" },
    "GET /system/hosts": { control: "never" },
    "DELETE /system/hosts/{id}": { control: "never" },
    // A peer's socket reconnects on its own backoff, so it answers before boot.
    "GET /system/hosts/connect": { auth: "door", beforeBoot: true, control: "never" },
    "POST /system/webext/pair": { control: "never" },
    "POST /system/webext/enroll": { auth: "door", control: "never" },
    "GET /system/webext": { control: "never" },
    "DELETE /system/webext/{id}": { control: "never" },
    "GET /system/webext/connect": { auth: "door", beforeBoot: true, control: "never" },
    "POST /system/runners/pair": { control: "never" },
    "POST /system/runners/enroll": { auth: "door", control: "never" },
    "GET /system/runners": { control: "never" },
    "DELETE /system/runners/{id}": { control: "never" },
    "GET /system/runners/connect": { auth: "door", beforeBoot: true, control: "never" },
    // A connected browser's credential doors, on its durable token: a sign-in moves in (`session`) or out (`lend`).
    "POST /system/webext/session": { auth: "door", control: "never" },
    "POST /system/webext/lend": { auth: "door", control: "never" },
    "POST /system/runners/{id}/definition/sync": { control: "never" },
    // A runner's git door and credential doors, each on the runner's own bearer.
    "GET /system/runners/git/{repo}/info/refs": { auth: "door", control: "never", lane: "bulk" },
    "POST /system/runners/git/{repo}/git-upload-pack": { auth: "door", control: "never", lane: "bulk" },
    "POST /system/runners/git/{repo}/git-receive-pack": { auth: "door", control: "never", lane: "bulk" },
    "POST /system/runners/credentials": { auth: "door", control: "never" },
    "POST /system/runners/credentials/refresh": { auth: "door", control: "never" },
    [`ALL ${runnerTranslatorPath}/*` as const]: { auth: "door", control: "never" },
    "POST /system/control/tokens": { control: "never" },
    "GET /system/control/tokens": { control: "never" },
    "DELETE /system/control/tokens/{id}": { control: "never" },
    // One's own passkeys are identity, like staying signed in; the policy and recovery codes are ownership's.
    "GET /system/passkeys": { guest: true, control: "never" },
    "POST /system/passkeys/register/options": { floor: "viewer", guest: true, enrolment: true, control: "never" },
    "POST /system/passkeys/register": { floor: "viewer", guest: true, enrolment: true, control: "never" },
    // The assertion has no bearer yet, since it is how one is minted.
    "POST /system/passkeys/assert/options": { auth: "door", beforeBoot: true, control: "never" },
    "POST /system/passkeys/assert": { auth: "door", beforeBoot: true, control: "never" },
    "POST /system/passkeys/policy": { control: "never" },
    "POST /system/passkeys/recovery": { control: "never" },
    // One's own passkey; the handler holds another member's to the owner.
    "DELETE /system/passkeys/{id}": { floor: "viewer", guest: true, control: "never" },
    // Checks its own bearer, since the require-passkey policy would otherwise hold out the owner it exists for.
    "POST /system/session/recover": { auth: "door", beforeBoot: true, control: "never" },
    "POST /system/sessions/revoke": { control: "never" },
    // Stays repeatable after a partial attempt; the handler does its own owner check.
    "POST /system/access/disable": { auth: "door", control: "never" },
    // The desktop-sync agent: redeems a one-time pairing, and later revokes with its own token.
    "POST /system/authorized-key": { auth: "door", control: "never" },
    "GET /system/sync": { control: "never" },
    // The sync agent's own machine report, the daemon's only view of SYNC_DIR.
    "POST /system/sync/report": { sync: "poll", control: "never" },
    "DELETE /system/authorized-key": { auth: "door", control: "never" },
    // The owner revoking one machine is no door: it goes through the session middleware.
    "DELETE /system/authorized-key/{machine}": { control: "never" },
} as const satisfies Readonly<Record<`${"GET" | "POST" | "PUT" | "DELETE" | "ALL"} /${string}`, RouteMeta>>;

export type RawRouteKey = keyof typeof RAW_ROUTES;

// A raw route's path, for a caller that builds a URL to it rather than registering it.
export const rawRoutePath = (key: RawRouteKey): string => key.slice(key.indexOf(" ") + 1);

// The table as routes of their own, each named by its key, in registration order.
export const RAW_ROUTE_LIST: readonly (ContractRoute & { readonly name: RawRouteKey })[] = (Object.keys(RAW_ROUTES) as RawRouteKey[]).map((name) => ({
    name,
    method: name.slice(0, name.indexOf(" ")),
    path: rawRoutePath(name),
    meta: RAW_ROUTES[name],
}));
