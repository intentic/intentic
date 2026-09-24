import type { IncomingMessage, ServerResponse } from "node:http";
import { panelFromHost, portSlotFromHost, publicSlotFromHost } from "@intentic/sandbox-contract";
import type { FrontHeader, PreviewRoute, Upstream } from "@intentic/sandbox-contract/front-wire";
import { escapeHtml } from "@intentic/base/format";
import type { PortTarget } from "../ports/port-forwards.js";
import type { PublicHandler } from "../public/public-serve.js";
import { interstitial, type Refusal } from "./interstitial.js";
import type { PanelServer, PanelUpstreamResolver } from "./panel-upstream.js";

// What a preview host (`preview-`, `port-`, `public-` labels) answers with: the front relays a serving upstream's bytes
// itself (_sandbox/front, proxy.rs) and hands everything else back here, marked, to be answered by Node.

// Resolves a forward slot to its mapped port and upstream scheme.
export type SlotResolver = (slot: string) => PortTarget | undefined;

// CORS-open so a browser can tell reachable from not; the string must match @intentic/ui's portPreview.ts.
export const PREVIEW_PROBE_PATH = "/__intentic/preview-probe";

// Set by the front on a request it hands back: answer it here, or render the page for an upstream that refused.
const ANSWER_HEADER: FrontHeader = "x-intentic-preview";
const UNREACHABLE_HEADER: FrontHeader = "x-intentic-preview-unreachable";

// What this side can answer for. `outbox` is absent without a connect token (tests, loopback), which has no salted
// slot to publish at.
export interface PreviewDeps {
    readonly panelOf: PanelUpstreamResolver;
    readonly slotTargetOf: SlotResolver;
    readonly sandboxId?: string | undefined;
    readonly outbox?: { readonly slot: string; readonly serve: PublicHandler } | undefined;
}

// What the probe reports: the sandbox's own view of the address. A browser only needs a readable response; curl gets
// the full diagnosis.
interface ProbeBody {
    readonly proxy: "intentic-preview";
    readonly target: "panel" | "port" | "outbox";
    readonly name?: string;
    readonly state: "serving" | "starting" | "several" | "stopped" | "unforwarded";
    readonly servers?: readonly PanelServer[];
}

type Resolved =
    | { readonly kind: "upstream"; readonly upstream: Upstream }
    | { readonly kind: "outbox" }
    | { readonly kind: "probe"; readonly body: ProbeBody }
    | ({ readonly kind: "refused" } & Refusal);

// Only an assigned port may keep the preview's Host; a self-pinned one's host check may only accept localhost.
const panelUpstream = async (deps: PreviewDeps, panel: string, probing: boolean): Promise<Resolved> => {
    const upstream = await deps.panelOf(panel);
    const name = escapeHtml(panel);
    if (probing) {
        return {
            kind: "probe",
            body: {
                proxy: "intentic-preview",
                target: "panel",
                name: panel,
                state: upstream.state,
                ...(upstream.state === "several" ? { servers: upstream.servers } : {}),
            },
        };
    }
    if (upstream.state === "serving") {
        return {
            kind: "upstream",
            upstream: { host: "127.0.0.1", port: upstream.port, scheme: "http", localhost: !upstream.assigned, frameable: true },
        };
    }
    if (upstream.state === "starting") {
        return {
            kind: "refused",
            status: 502,
            title: "Preview is starting",
            message: `"${name}" is starting and hasn't opened a port yet: its terminal in the sandbox shows how far it has got`,
        };
    }
    if (upstream.state === "several") {
        // Naming them is the answer: one hostname can't stand for several servers; only the user knows which one.
        const listed = upstream.servers.map((server) => escapeHtml(`${server.dir ?? name}:${server.port}`)).join(", ");
        return {
            kind: "refused",
            status: 502,
            title: "Several servers here",
            message: `"${name}" is running ${upstream.servers.length} dev servers on ports of their own (${listed}), so this one address can't stand for it: forward the one you want from the Ports view and preview that`,
        };
    }
    return {
        kind: "refused",
        status: 502,
        title: "Preview isn't running",
        message: `panel "${name}" is not running, start it from the ${name} entry in the sidebar`,
    };
};

const resolve = async (host: string | undefined, deps: PreviewDeps, probing: boolean): Promise<Resolved> => {
    const panel = panelFromHost(host, deps.sandboxId);
    if (panel !== undefined) {
        return panelUpstream(deps, panel, probing);
    }
    const slot = portSlotFromHost(host, deps.sandboxId);
    if (slot !== undefined) {
        const target = deps.slotTargetOf(slot);
        if (probing) {
            return { kind: "probe", body: { proxy: "intentic-preview", target: "port", state: target === undefined ? "unforwarded" : "serving" } };
        }
        if (target === undefined) {
            return {
                kind: "refused",
                status: 502,
                title: "Nothing forwarded here",
                message: `nothing is forwarded here, re-open the preview from the Ports view or the terminal link`,
            };
        }
        return { kind: "upstream", upstream: { host: target.host, port: target.port, scheme: target.scheme, localhost: true, frameable: true } };
    }
    // One salted outbox slot per sandbox; any other public- slot is a stray subdomain the wildcard caught.
    if (deps.outbox !== undefined && publicSlotFromHost(host, deps.sandboxId) === deps.outbox.slot) {
        return probing ? { kind: "probe", body: { proxy: "intentic-preview", target: "outbox", state: "serving" } } : { kind: "outbox" };
    }
    return { kind: "refused", status: 404, title: "No preview here", message: "This address isn't a live Intentic preview." };
};

// The front's question: relay to this upstream yourself, or hand the request back.
export const previewRoute = async (host: string, deps: PreviewDeps): Promise<PreviewRoute> => {
    const resolved = await resolve(host, deps, false);
    return resolved.kind === "upstream" ? { to: "upstream", upstream: resolved.upstream } : { to: "node" };
};

// Whether the front marked this request as one of the handed-back previews above.
export const isHandedBackPreview = (request: IncomingMessage): boolean =>
    request.headers[ANSWER_HEADER] !== undefined || request.headers[UNREACHABLE_HEADER] !== undefined;

const refuse = (response: ServerResponse, refusal: Refusal): void => {
    response.writeHead(refusal.status, { "content-type": "text/html; charset=utf-8" });
    response.end(interstitial(refusal.title, refusal.message));
};

export const answerPreview = async (request: IncomingMessage, response: ServerResponse, deps: PreviewDeps): Promise<void> => {
    const unreachable = request.headers[UNREACHABLE_HEADER];
    if (unreachable !== undefined) {
        const port = escapeHtml(String(unreachable));
        refuse(response, { status: 502, title: "Preview unavailable", message: `nothing is answering on port ${port}: the server may have stopped` });
        return;
    }
    const probing = (request.url ?? "").split("?")[0] === PREVIEW_PROBE_PATH;
    const resolved = await resolve(request.headers.host, deps, probing);
    if (resolved.kind === "probe") {
        // Cross-origin readable by design; carries no sandbox content, never cached since state changes by the second.
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" });
        response.end(JSON.stringify(resolved.body));
        return;
    }
    if (resolved.kind === "refused") {
        refuse(response, resolved);
        return;
    }
    if (resolved.kind === "outbox") {
        await deps.outbox?.serve(request, response);
        return;
    }
    // It started serving between the front's question and this answer; the next request is relayed.
    response.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "1" });
    response.end(interstitial("Preview is starting", "it has just opened its port: reload in a moment"));
};
