import type { IncomingMessage, ServerResponse } from "node:http";
import { panelFromHost, portSlotFromHost, publicSlotFromHost } from "@intentic/sandbox-contract";
import type { FrontHeader, Page, PreviewRoute, Upstream } from "@intentic/sandbox-contract/front-wire";
import { escapeHtml } from "@intentic/base/format";
import type { PortTarget } from "../ports/port-forwards.js";
import type { PublicHandler } from "../public/public-serve.js";
import { interstitial, type Refusal } from "./interstitial.js";
import type { PanelServer, PanelUpstreamResolver } from "./panel-upstream.js";

// What a preview host (`preview-`, `port-`, `public-` labels) answers with, decided once when the front asks
// (_sandbox/front, proxy.rs): the front relays a serving upstream's bytes itself and writes a refusal or the probe's
// report as the page rendered here, so only the outbox, and an upstream that refused the front, come back here marked.

// Resolves a forward slot to its mapped port and upstream scheme.
export type SlotResolver = (slot: string) => PortTarget | undefined;

// CORS-open so a browser can tell reachable from not; the string must match @intentic/ui's portPreview.ts.
export const PREVIEW_PROBE_PATH = "/__intentic/preview-probe";

// Set by the front on a request it hands back: the outbox this side decided it is, or the page for an upstream that
// refused the front's connection.
const ANSWER_HEADER: FrontHeader = "x-intentic-preview";
const OUTBOX = "outbox";
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

const HTML = { "content-type": "text/html; charset=utf-8" };

const refusalPage = (refusal: Refusal): Page => ({ status: refusal.status, headers: HTML, body: interstitial(refusal.title, refusal.message) });

// Cross-origin readable by design; carries no sandbox content, never cached since state changes by the second.
const probePage = (body: ProbeBody): Page => ({
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" },
    body: JSON.stringify(body),
});

// The front's question, answered with everything it needs to act: relay to this upstream, write this page, or hand the
// request back as the outbox. `probe` asks for the probe's report, whatever the host resolves to.
export const previewRoute = async (host: string, probe: boolean, deps: PreviewDeps): Promise<PreviewRoute> => {
    const resolved = await resolve(host, deps, probe);
    switch (resolved.kind) {
        case "upstream":
            return { to: "upstream", upstream: resolved.upstream };
        case "outbox":
            return { to: "outbox" };
        case "probe":
            return { to: "page", page: probePage(resolved.body) };
        case "refused":
            return { to: "page", page: refusalPage(resolved) };
    }
};

// Whether the front marked this request as one of the handed-back previews above.
export const isHandedBackPreview = (request: IncomingMessage): boolean =>
    request.headers[ANSWER_HEADER] !== undefined || request.headers[UNREACHABLE_HEADER] !== undefined;

const refuse = (response: ServerResponse, refusal: Refusal): void => {
    response.writeHead(refusal.status, HTML);
    response.end(interstitial(refusal.title, refusal.message));
};

// Answers what the front handed back, nothing resolved again: the outbox it was decided to be, or the page for an
// upstream that stopped answering between the question and the relay.
export const answerPreview = async (request: IncomingMessage, response: ServerResponse, deps: PreviewDeps): Promise<void> => {
    const unreachable = request.headers[UNREACHABLE_HEADER];
    if (unreachable !== undefined) {
        const port = escapeHtml(String(unreachable));
        refuse(response, { status: 502, title: "Preview unavailable", message: `nothing is answering on port ${port}: the server may have stopped` });
        return;
    }
    if (request.headers[ANSWER_HEADER] === OUTBOX && deps.outbox !== undefined) {
        await deps.outbox.serve(request, response);
        return;
    }
    refuse(response, { status: 404, title: "No preview here", message: "This address isn't a live Intentic preview." });
};
