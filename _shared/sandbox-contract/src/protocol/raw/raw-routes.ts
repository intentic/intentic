import type { RouteMeta } from "../route-meta.js";
import { fillRoutePath, type RoutePathParams } from "./route-path.js";
import type { ContractRoute } from "../routes.js";
import { runnerTranslatorPath } from "../doors/runner-protocol.js";

// Every route the daemon serves outside oRPC (streamed bytes, WebSocket upgrades, doors checking their own credential),
// keyed `METHOD /path` in the order the daemon registers them: among overlapping ones the first registered answers.
// `{param}` is one path segment, a trailing `/*` any further ones, `ALL` every method; the daemon serves no other.
// A route that answers plain JSON has its input and answer schemas in raw-json-routes.ts, under the same key.
export const RAW_ROUTES = {
    // The "is a daemon there" probe every flow uses; it names the sandbox and says whether it is still converging.
    "GET /health": { auth: "door", beforeBoot: true },
    // A person opening this sandbox's own address in a browser: sent to the app's /open on it, the address being what
    // they may still hold when the platform has lost the rest. Anything else gets the same 401 as before it existed.
    "GET /": { auth: "door", beforeBoot: true },
    "GET /diff/raw": { lane: "bulk" },
    // Arming the dictation model is a read any tier makes; dictating is writing a message, the collaborator's grant.
    "GET /speech/status": { guest: true },
    "POST /speech/prepare": { guest: true },
    "POST /speech/transcribe": { floor: "collaborator", guest: true },
    // The live phrase stream (schemas/speech.ts): a WebSocket, so the query ticket, floored at the collaborator in the
    // handler like the transcribe it streams.
    "GET /speech/stream": { auth: "door" },
    // The bytes behind the workspace reads; each applies the caller's fence itself.
    "GET /workspace/raw": { guest: true, lane: "bulk" },
    // No door, unlike media: the page fetches a thumbnail itself, so the request carries the header.
    "GET /workspace/thumb": { guest: true },
    // Fetched by a <video>/<audio> tag, which sends no header: its scoped ticket is checked in the handler.
    "GET /workspace/media": { auth: "door", guest: true, lane: "bulk" },
    // Navigated to for a ZIP of a selection, so no header either: the ticket it carries names the selection.
    "GET /workspace/download": { auth: "door", guest: true, lane: "bulk" },
    // An attachment is part of the message it rides with; any other target edits the shared tree.
    "POST /workspace/upload": { floor: "writer", attachmentFloor: "collaborator", lane: "bulk" },
    "POST /workspace/upload-diff": {},
    "POST /workspace/upload-archive": { lane: "bulk" },
    // Minting is cheap: each WebSocket upgrade floors its own redemption.
    "POST /system/ws-ticket": { beforeBoot: true, floor: "collaborator", control: "never" },
    // A WebSocket upgrade carries no Authorization header; the terminal, both browser wires and the desktop's check a
    // query ticket.
    "GET /system/terminal": { auth: "door", beforeBoot: true, control: "never", netd: true },
    // netd's proof of life (vitals.ts): no credential and nothing of the workspace, readable by any origin, answered
    // whatever state the daemon is in.
    "GET /system/vitals": { auth: "door", beforeBoot: true, netd: true },
    // Desktop sync's byte pipe, guarded again by sshd's own key check against the same enrollment.
    "GET /system/sync/ssh": { sync: "pipe", control: "never", lane: "bulk" },
    "GET /system/browser-profile": { auth: "door", beforeBoot: true, control: "never" },
    "GET /system/browser-view": { auth: "door", beforeBoot: true, control: "never" },
    // The sandbox's own desktop, watched and driven by the owner (desktop/desktop-view.ts); the same query ticket.
    "GET /system/desktop-view": { auth: "door", beforeBoot: true, control: "never" },
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
    // The owner's Reconnect: register with the platform now, having it adopt the sandbox first when it holds no record.
    "POST /platform/relink": { control: "never" },
    "GET /environment": {},
    "GET /environment/contents": {},
    "POST /environment/approve": {},
    "POST /environment/reject": {},
    "POST /environment/runtime-install": {},
    "POST /environment/remove": {},
    "POST /environment/rebuild-when-idle": {},
    "DELETE /environment/rebuild-when-idle": {},
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
    // Model API keys on the owner's devices, and turning the picked ones into model endpoints.
    "GET /arrivals/keys": {},
    "POST /arrivals/keys/apply": {},
    "DELETE /arrivals": {},
    "GET /extensions/{id}/bundle": { lane: "bulk" },
    // An extension backend's own namespace, proxied verbatim.
    "ALL /x/*": {},
    // The `capabilities` CLI's discovery by name; its ask is the needs door (contracts/needs.contract.ts).
    "GET /capabilities/connectable": { floor: "maintainer", agent: true, control: "never" },
    // The `sandboxes` CLI; every create parks on a card in the owner's chat first.
    "GET /sandboxes": { agent: true },
    "POST /sandboxes": { agent: true },
    // The `wallet` CLI; spend is bounded by the owner's policy and the key never enters the container.
    "GET /wallet/status": { agent: true, control: "never" },
    "POST /wallet/fetch": { agent: true, control: "never" },
    "GET /wallet/history": { agent: true, control: "never" },
    // The `agents` CLI's children: start, follow up, answer (never a consent card), cancel, merge held work, list.
    "POST /children/spawn": { agent: true, control: "never" },
    "GET /children/providers": { agent: true, control: "never" },
    "POST /children/wait": { agent: true, control: "never" },
    "POST /children/send": { agent: true, control: "never" },
    "POST /children/answer": { agent: true, control: "never" },
    "POST /children/cancel": { agent: true, control: "never" },
    "POST /children/merge": { agent: true, control: "never" },
    "GET /children": { agent: true, control: "never" },
    // The fleet reads, and the one write: words in front of another conversation, which a person can do by typing.
    "GET /fleet": { agent: true },
    "POST /fleet/message": { agent: true },
    "GET /fleet/{handle}": { agent: true },
    // The `devices push` CLI: a program the agent built, carried to one of the owner's computers in chunks; held to the
    // devices the calling conversation's turn mounts, and refused by the machine itself unless "Run programs" is on.
    "POST /devices/{name}/artifacts": { agent: true, control: "never" },
    // The rest of the `devices` command, held to the same rule (hosts/device-door.ts): the device's app_start for a
    // shell, and its loopback ports reached from the sandbox (hosts/device-tunnels.ts).
    "POST /devices/{name}/apps": { agent: true, control: "never" },
    "POST /devices/{name}/tunnels": { agent: true, control: "never" },
    "DELETE /devices/{name}/tunnels/{port}": { agent: true, control: "never" },
    "GET /devices/tunnels": { agent: true },
    // Where a device dials back with a tunnel's one-time ticket; the ticket is the whole credential, checked by the route.
    "GET /system/hosts/tunnel": { auth: "door", control: "never" },
    // An extension gateway's realtime-listener control: /state hands back its connectors' stored credentials, so only the
    // extension token of the extension declaring that `listener.provider` reaches them, checked in the handler too.
    "GET /listeners/{provider}/state": { floor: "maintainer", panel: false, control: "never" },
    "POST /listeners/{provider}/dispatch": { panel: false, control: "never" },
    "POST /listeners/{provider}/failure": { panel: false, control: "never" },
    "POST /listeners/{provider}/status": { panel: false, control: "never" },
    // What an extension's own code asks about itself (extension-protocol.ts): its settings with their secrets, and its
    // event stream. Every extension token reaches both undeclared, and each answers only about the extension asking, so
    // no other credential reaches them; the handler resolves the caller from its token again.
    "GET /extension/settings": { floor: "maintainer", panel: false, control: "never" },
    "GET /extension/events": { floor: "maintainer", panel: false, control: "never", stream: true },
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
    "POST /system/phones/pair": { control: "never" },
    "POST /system/phones/enroll": { auth: "door", control: "never" },
    "GET /system/phones": { control: "never" },
    "DELETE /system/phones/{id}": { control: "never" },
    "GET /system/phones/connect": { auth: "door", beforeBoot: true, control: "never" },
    // The editor hands over the push-relay channel it registered for a phone, so the sandbox can wake it.
    "POST /system/phones/{id}/wake": { control: "never" },
    "POST /system/runners/pair": { control: "never" },
    "POST /system/runners/enroll": { auth: "door", control: "never" },
    "GET /system/runners": { control: "never" },
    "DELETE /system/runners/{id}": { control: "never" },
    "GET /system/runners/connect": { auth: "door", beforeBoot: true, control: "never" },
    // Every MCP server the daemon hosts for a turn (its browser routers, the machines and browsers it was granted, its
    // extension cards' endpoints), by server name: the handler checks the conversation's mount bearer the turn's tool
    // config carries, and that the running turn mounted that name.
    "ALL /mcp/{mount}": { auth: "door", control: "never" },
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
    // The privacy shield's gateway: every shielded runtime's model requests, on the signed session its base URL carries
    // (privacy/gateway/session-token.ts), which names the provider and the only upstream it may forward to. Held open
    // while a model streams its answer.
    "ALL /privacy/gateway/{session}/*": { auth: "door", control: "never", stream: true },
    // Its sibling for MCP: a hooked runtime's (Cursor's) calls to its turn's MCP servers, on a session signed the same
    // way, naming the provider and the one server it may forward to. Held open while a server streams its answer.
    "ALL /privacy/mcp/{session}": { auth: "door", control: "never", stream: true },
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

// The `{param}` values a raw route's path needs, by name; an empty record for a route with none.
export type RawRouteParams<Key extends RawRouteKey> = Readonly<Record<RoutePathParams<Key>, string>>;

// The path to call a raw route at: its template with every `{param}` filled and encoded as one segment. The one place a
// caller outside the daemon spells a raw route, so a path that moves in the table moves for every caller.
export const rawRouteUrl = <Key extends RawRouteKey>(
    key: Key,
    ...[params]: [RoutePathParams<Key>] extends [never] ? [] : [params: RawRouteParams<Key>]
): string => fillRoutePath(rawRoutePath(key), params);

// The table as routes of their own, each named by its key, in registration order.
export const RAW_ROUTE_LIST: readonly (ContractRoute & { readonly name: RawRouteKey })[] = (Object.keys(RAW_ROUTES) as RawRouteKey[]).map((name) => ({
    name,
    method: name.slice(0, name.indexOf(" ")),
    path: rawRoutePath(name),
    meta: RAW_ROUTES[name],
}));
