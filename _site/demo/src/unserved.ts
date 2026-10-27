import { RAW_ROUTE_LIST, type RawRouteKey } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import type { SandboxGroup, SandboxProcedure } from "@intentic/sandbox-contract/protocol/procedure-types";
import type { sockets } from "./daemon";
import type { procedures } from "./daemon/procedures";
import type { raw } from "./daemon/raw";

// Every contract route the fixture daemon leaves unanswered, and why: the demo's real coverage, stated. The demo's
// typecheck holds this list to the contract in both directions. A route the fixture neither serves nor lists here is a
// missing property below, and a listed one that the fixture now serves, or that the contract dropped, is an unknown one.
// So a new route lands with a decision: answer it in daemon/, or give it a reason here.

type ContractRoute = { readonly [G in SandboxGroup]: `${G}.${SandboxProcedure<G>}` }[SandboxGroup] | RawRouteKey;
type Procedures = typeof procedures;
type Served =
    { readonly [G in keyof Procedures]: `${G}.${keyof Procedures[G] & string}` }[keyof Procedures] | keyof typeof raw | keyof typeof sockets;
type Unserved = Exclude<ContractRoute, Served>;

// Out of the demo by design: nothing the editor does reaches these, or they need something a browser tab can't fake.
const NOT_THE_EDITORS = `Not an editor call: the ic CLI, an agent's tools, a paired machine, a listener process, a webhook sender or a CI job makes it.`;
const OFF_SITE = `Answers a visitor's browser on the owner's own site (the web-chat widget, the bug-report intake), never the editor.`;
const ISSUES_INBOX = `An issue's own actions: the inbox the vendored issues extension reads is answered, and empty, so there is no issue to act on.`;

// No gap a visitor can reach is listed (2026-10-27): every route the editor calls is answered, a machine's and a sign-in's
// included, so a new route the editor reaches is served rather than given a reason here.

export const UNSERVED = {
    "ALL /mcp/{mount}": NOT_THE_EDITORS,
    "ALL /privacy/gateway/{session}/*": NOT_THE_EDITORS,
    "ALL /privacy/mcp/{session}": NOT_THE_EDITORS,
    "ALL /system/runners/translator/*": NOT_THE_EDITORS,
    "DELETE /devices/{name}/tunnels/{port}": NOT_THE_EDITORS,
    "DELETE /system/authorized-key": NOT_THE_EDITORS,
    "DELETE /system/hosts/{id}": NOT_THE_EDITORS,
    "DELETE /system/webext/{id}": NOT_THE_EDITORS,
    "GET /": NOT_THE_EDITORS,
    "GET /capabilities/connectable": NOT_THE_EDITORS,
    "GET /children": NOT_THE_EDITORS,
    "GET /children/links": NOT_THE_EDITORS,
    "GET /children/providers": NOT_THE_EDITORS,
    "GET /devices/tunnels": NOT_THE_EDITORS,
    "GET /extension/events": NOT_THE_EDITORS,
    // What an extension's own backend or process asks about itself (its settings, what moved); the editor never does.
    "GET /extension/settings": NOT_THE_EDITORS,
    "GET /favicon.ico": NOT_THE_EDITORS,
    "GET /fleet": NOT_THE_EDITORS,
    "GET /fleet/{handle}": NOT_THE_EDITORS,
    "GET /intake/sdk.js": OFF_SITE,
    "GET /intake/{id}/challenge": OFF_SITE,
    "GET /intake/{id}/config": OFF_SITE,
    // A keyring on the owner's computer fetches this sandbox's public keys here before it shares anything with it.
    "GET /keyring/keys": NOT_THE_EDITORS,
    "GET /link": NOT_THE_EDITORS,
    "GET /link/conversations/{id}": NOT_THE_EDITORS,
    "GET /listeners/{provider}/state": NOT_THE_EDITORS,
    "GET /sandboxes": NOT_THE_EDITORS,
    "GET /system/hosts/connect": NOT_THE_EDITORS,
    "GET /system/hosts/tunnel": NOT_THE_EDITORS,
    "GET /system/phones/connect": NOT_THE_EDITORS,
    "GET /system/phones/passwords/keyrings": NOT_THE_EDITORS,
    "GET /system/runners/connect": NOT_THE_EDITORS,
    "GET /system/runners/git/{repo}/info/refs": NOT_THE_EDITORS,
    "GET /system/sync/ssh": NOT_THE_EDITORS,
    "GET /system/webext/connect": NOT_THE_EDITORS,
    "GET /wallet/history": NOT_THE_EDITORS,
    "GET /wallet/status": NOT_THE_EDITORS,
    "GET /webchat/widget.js": OFF_SITE,
    "GET /webchat/{id}/challenge": OFF_SITE,
    "GET /webchat/{id}/config": OFF_SITE,
    "GET /webchat/{id}/messages": OFF_SITE,
    "POST /automations/{id}/fire": NOT_THE_EDITORS,
    "POST /children/answer": NOT_THE_EDITORS,
    "POST /children/cancel": NOT_THE_EDITORS,
    // An agent handing a task to a linked sandbox (`agents delegate`, `agents links`), and the link doors the asking
    // sandbox's daemon calls: the demo is linked to no other sandbox.
    "POST /children/delegate": NOT_THE_EDITORS,
    "POST /children/merge": NOT_THE_EDITORS,
    "POST /children/providers/spent": NOT_THE_EDITORS,
    "POST /children/send": NOT_THE_EDITORS,
    "POST /children/settle": NOT_THE_EDITORS,
    "POST /children/spawn": NOT_THE_EDITORS,
    "POST /children/wait": NOT_THE_EDITORS,
    "POST /ci/webhook/{host}": NOT_THE_EDITORS,
    // The rest of the agent's `devices` command (a shell's app_start, a device port reached from the sandbox), and where
    // the device dials back with a tunnel's ticket.
    "POST /devices/{name}/apps": NOT_THE_EDITORS,
    "POST /devices/{name}/artifacts": NOT_THE_EDITORS,
    "POST /devices/{name}/tunnels": NOT_THE_EDITORS,
    "POST /enroll": NOT_THE_EDITORS,
    "POST /fleet/message": NOT_THE_EDITORS,
    "POST /fleet/resume": NOT_THE_EDITORS,
    "POST /intake/{id}/report": OFF_SITE,
    "POST /link/conversations": NOT_THE_EDITORS,
    "POST /link/conversations/{id}/answer": NOT_THE_EDITORS,
    "POST /link/conversations/{id}/messages": NOT_THE_EDITORS,
    "POST /link/conversations/{id}/stop": NOT_THE_EDITORS,
    "POST /listeners/{provider}/dispatch": NOT_THE_EDITORS,
    "POST /listeners/{provider}/failure": NOT_THE_EDITORS,
    "POST /listeners/{provider}/status": NOT_THE_EDITORS,
    "POST /listeners/{provider}/stop": NOT_THE_EDITORS,
    "POST /sandboxes": NOT_THE_EDITORS,
    "POST /sandboxes/remove": NOT_THE_EDITORS,
    // Speaking over HTTP is the Discord extension's gateway, a process on the sandbox, not the editor: it speaks over GET /speech/say.
    "POST /speech/say": NOT_THE_EDITORS,
    "POST /system/authorized-key": NOT_THE_EDITORS,
    // The owner mints a server-connect code for a machine of their own; the install script on that machine redeems it.
    "POST /system/hosts/enroll": NOT_THE_EDITORS,
    "POST /system/hosts/keyring-changed": NOT_THE_EDITORS,
    "POST /system/hosts/pair": NOT_THE_EDITORS,
    // Minting, re-terming and revoking a link, and the owner's answer to a task one holds: the Access tab sends them.
    "POST /system/phones/enroll": NOT_THE_EDITORS,
    "POST /system/phones/passwords/capture": NOT_THE_EDITORS,
    "POST /system/phones/passwords/fill": NOT_THE_EDITORS,
    "POST /system/phones/passwords/pair": NOT_THE_EDITORS,
    "POST /system/redeem/{code}": NOT_THE_EDITORS,
    "POST /system/runners/credentials": NOT_THE_EDITORS,
    "POST /system/runners/credentials/refresh": NOT_THE_EDITORS,
    "POST /system/runners/enroll": NOT_THE_EDITORS,
    "POST /system/runners/git/{repo}/git-receive-pack": NOT_THE_EDITORS,
    "POST /system/runners/git/{repo}/git-upload-pack": NOT_THE_EDITORS,
    "POST /system/runners/pair": NOT_THE_EDITORS,
    "POST /system/sync/report": NOT_THE_EDITORS,
    "POST /system/webext/enroll": NOT_THE_EDITORS,
    "POST /system/webext/grants-changed": NOT_THE_EDITORS,
    "POST /system/webext/lend": NOT_THE_EDITORS,
    "POST /system/webext/pair": NOT_THE_EDITORS,
    "POST /system/webext/secret": NOT_THE_EDITORS,
    "POST /system/webext/session": NOT_THE_EDITORS,
    "POST /wallet/fetch": NOT_THE_EDITORS,
    "POST /webchat/{id}/message": OFF_SITE,
    "POST /workflows/{id}/gate": NOT_THE_EDITORS,
    // The desktop app's status bar and `ic sandbox attention` read it with a session minted for the owner; no view does.
    "agents.attention": NOT_THE_EDITORS,
    "agents.get": NOT_THE_EDITORS,
    "capabilities.connection": NOT_THE_EDITORS,
    // A connector's own CLI or listener stores a delegated sign-in's refresh token; no page sends it.
    "capabilities.oauthToken": NOT_THE_EDITORS,
    "capabilities.otp": NOT_THE_EDITORS,
    "capabilities.status": NOT_THE_EDITORS,
    "exit.check": NOT_THE_EDITORS,
    "exit.countries": NOT_THE_EDITORS,
    "exit.list": NOT_THE_EDITORS,
    "exit.rotate": NOT_THE_EDITORS,
    "exit.start": NOT_THE_EDITORS,
    "exit.stop": NOT_THE_EDITORS,
    "exit.use": NOT_THE_EDITORS,
    // `extension dev`: an agent's or a person's CLI points the sandbox at a checkout and rebuilds it; the editor only clears it.
    "extensions.devList": NOT_THE_EDITORS,
    "extensions.devReload": NOT_THE_EDITORS,
    "extensions.devSet": NOT_THE_EDITORS,
    "git.files": NOT_THE_EDITORS,
    "git.remote": NOT_THE_EDITORS,
    "git.stashPush": NOT_THE_EDITORS,
    "git.status": NOT_THE_EDITORS,
    "git.writeFile": NOT_THE_EDITORS,
    "issues.installs": ISSUES_INBOX,
    "issues.investigate": ISSUES_INBOX,
    "issues.remove": ISSUES_INBOX,
    "issues.status": ISSUES_INBOX,
    "logs.list": NOT_THE_EDITORS,
    "logs.read": NOT_THE_EDITORS,
    "loops.list": NOT_THE_EDITORS,
    // The agent's side of needs: its CLIs raise, list, close and withdraw them; the editor only reads and answers.
    "needs.ask": NOT_THE_EDITORS,
    "needs.done": NOT_THE_EDITORS,
    "needs.mine": NOT_THE_EDITORS,
    "needs.withdraw": NOT_THE_EDITORS,
    "offload.cancel": NOT_THE_EDITORS,
    "offload.run": NOT_THE_EDITORS,
    "offload.target": NOT_THE_EDITORS,
    // Only an MCP server's app calls it, and no fixture conversation shows one.
    // Only a fixture page that throws would send it, and none does; a page's own line offers the ask either way.
    "privacy.learn": NOT_THE_EDITORS,
    // The words of a sent notification, for the native app whose push carried only its tag; the web editor gets the words in the push.
    "push.notification": NOT_THE_EDITORS,
    "secrets.request": NOT_THE_EDITORS,
    "secrets.want": NOT_THE_EDITORS,
    // The agent execution domain: no editor view reads or sets it (panel: false), and the demo runs no agent to isolate.
    // The agent execution domain is set from the CLI; no view reads or writes it.
    "settings.agentDomain": NOT_THE_EDITORS,
    // The AI notice is off in the demo's settings, so the card never asks for its status or confirmations.
    "settings.setAgentDomain": NOT_THE_EDITORS,
    "workspace.classify": NOT_THE_EDITORS,
    "workspace.setup": NOT_THE_EDITORS,
    "workspace.sync": NOT_THE_EDITORS,
} satisfies Record<Unserved, string>;

const CONTRACT_ROUTES = SANDBOX_ROUTE_NAMES.length + RAW_ROUTE_LIST.length;

/** How much of the real daemon this fixture stands in for, reported once at boot, so the gap is visible. */
export const coverage = () => ({ contract: CONTRACT_ROUTES, served: CONTRACT_ROUTES - Object.keys(UNSERVED).length });
