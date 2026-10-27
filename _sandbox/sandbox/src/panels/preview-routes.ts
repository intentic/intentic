import type { IncomingMessage, ServerResponse } from "node:http";
import { panelFromHost, portSlotFromHost, publicSlotFromHost } from "@intentic/sandbox-contract/ids/hostnames";
import type { NetdHeader, Page, PreviewRoute, Upstream } from "@intentic/sandbox-contract/netd-wire";
import { escapeHtml } from "@intentic/base/format";
import type { PortTarget } from "../ports/port-forwards.js";
import type { PublicHandler } from "../public/public-serve.js";
import { interstitial, type InterstitialExtras, type Refusal } from "./interstitial.js";
import type { PanelServer, PanelUpstream, PanelUpstreamResolver } from "./panel-upstream.js";
import { PREVIEW_PASS_PATH, passCookie, type PreviewGuards } from "../auth/previews/preview-guard.js";

// What a preview host (`preview-`, `port-`, `public-` labels) answers with, decided once when netd asks
// (_sandbox/netd, proxy.rs): netd relays a serving upstream's bytes itself and writes a refusal or the probe's
// report as the page rendered here, so only the outbox, an upstream that refused netd, and what the owner's preview
// guard hands back (a pass's exchange, a navigation with no pass; auth/previews/preview-guard.ts) come back here marked.

// Resolves a forward slot to its mapped port and upstream scheme.
export type SlotResolver = (slot: string) => PortTarget | undefined;

// CORS-open so a browser can tell reachable from not; the string must match @intentic/ui's portPreview.ts.
export const PREVIEW_PROBE_PATH = "/__intentic/preview-probe";

// Set by netd on a request it hands back: the outbox this side decided it is, a pass being exchanged or a navigation
// the owner's guard refused (preview-guard.ts), or the page for an upstream that refused netd's connection.
const ANSWER_HEADER: NetdHeader = "x-intentic-preview";
const OUTBOX = "outbox";
const PASS = "pass";
const SIGN_IN = "signin";
const UNREACHABLE_HEADER: NetdHeader = "x-intentic-preview-unreachable";

// What this side can answer for. `outbox` is absent without a connect token (tests, loopback), which has no salted
// slot to publish at.
export interface PreviewDeps {
    readonly panelOf: PanelUpstreamResolver;
    readonly slotTargetOf: SlotResolver;
    readonly sandboxId?: string | undefined;
    readonly outbox?: { readonly slot: string; readonly serve: PublicHandler } | undefined;
    // A page of this panel was asked for (never a probe): true when that woke an app rested for want of visitors
    // (scaffold/app-rest.ts), so the visitor is told it is starting rather than that it is not running.
    readonly visit?: (panel: string) => boolean;
    // The owner's guard, and the editor a visitor without a pass is sent to for one; absent where nothing is guarded.
    readonly guard?: { readonly guards: Pick<PreviewGuards, "redeem" | "pass">; readonly editorOrigin: string | undefined } | undefined;
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
    const woke = !probing && deps.visit?.(panel) === true;
    const resolved = await deps.panelOf(panel);
    // The scan may not have seen the session the wake just opened, and "not running" would send the visitor away.
    const upstream: PanelUpstream = woke && resolved.state === "stopped" ? { state: "starting" } : resolved;
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
            message: woke
                ? `"${name}" was resting while nobody used it and is starting again: this page reloads by itself once it answers`
                : `"${name}" is starting and hasn't opened a port yet: its terminal in the sandbox shows how far it has got`,
            // A starting server answers within seconds; the visitor should not have to know to reload.
            refreshSeconds: 3,
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

const refusalPage = (refusal: Refusal): Page => ({
    status: refusal.status,
    headers: HTML,
    body: interstitial(refusal.title, refusal.message, refusal.refreshSeconds),
});

// Cross-origin readable by design; carries no sandbox content, never cached since state changes by the second.
const probePage = (body: ProbeBody): Page => ({
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" },
    body: JSON.stringify(body),
});

// netd's question, answered with everything it needs to act: relay to this upstream, write this page, or hand the
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

// Whether netd marked this request as one of the handed-back previews above.
export const isHandedBackPreview = (request: IncomingMessage): boolean =>
    request.headers[ANSWER_HEADER] !== undefined || request.headers[UNREACHABLE_HEADER] !== undefined;

const refuse = (response: ServerResponse, refusal: Refusal): void => {
    response.writeHead(refusal.status, HTML);
    response.end(interstitial(refusal.title, refusal.message));
};

// Asks the editor framing this page for a pass, which it answers by loading the preview again through one; framed by
// anything else, the message names an address the framer already has. In a tab of its own the page waits for a press.
const ASK_THE_FRAME = `if(window.parent!==window){var go=document.getElementById("go");if(go){go.target="_blank";go.rel="noopener"}window.parent.postMessage({intentic:"preview-pass",href:location.href},"*")}`;

// The host a request was handed back for, without a port: what a ticket is bound to.
const hostOf = (request: IncomingMessage): string => String(request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();

// A path on the same host to land on, never another host (`//`, `/\`) and never the exchange again.
const landingPath = (to: string | null): string =>
    to !== null && to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\") && !/[\u0000-\u001f]/.test(to) && !to.startsWith(PREVIEW_PASS_PATH)
        ? to
        : "/";

// The page a navigation without a pass gets, and a ticket that did not redeem: 401, never cached, with the way to a pass
// (the editor's /preview-pass, which signs this browser in to the address and brings it back).
const signInPage = (response: ServerResponse, guard: NonNullable<PreviewDeps["guard"]>, host: string, path: string, expired: boolean): void => {
    const back = `https://${host}${path}`;
    // Without an editor to send the visitor to, the page still says what this is; the editor's own frame asks anyway.
    const extras: InterstitialExtras =
        guard.editorOrigin === undefined
            ? { script: ASK_THE_FRAME }
            : { action: { label: "Continue to Intentic", href: `${guard.editorOrigin}/preview-pass?url=${encodeURIComponent(back)}` }, script: ASK_THE_FRAME };
    response.writeHead(401, { ...HTML, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    response.end(
        interstitial(
            expired ? "This sign-in link has expired" : "This preview is for the sandbox's members",
            expired
                ? "Links that sign you in to a preview work once, for a minute. Open it again from Intentic to get a fresh one."
                : "Its owner keeps it to the people they invited. Sign in with Intentic and you'll be brought straight back here.",
            undefined,
            extras,
        ),
    );
};

// The exchange: a ticket minted for this host becomes the pass, a cookie on this host, and the browser lands where it
// asked to go. Only ever reached on a host the guard covers, since netd hands the path back nowhere else.
const exchangePass = async (request: IncomingMessage, response: ServerResponse, guard: NonNullable<PreviewDeps["guard"]>): Promise<void> => {
    const asked = new URL(request.url ?? "/", "https://preview.invalid");
    const to = landingPath(asked.searchParams.get("to"));
    const host = hostOf(request);
    if (request.method !== "GET" || guard.guards.redeem(asked.searchParams.get("ticket") ?? "", host) === undefined) {
        signInPage(response, guard, host, to, true);
        return;
    }
    response.writeHead(302, { location: to, "set-cookie": passCookie(await guard.guards.pass()), "cache-control": "no-store", "referrer-policy": "no-referrer" });
    response.end();
};

// Answers what netd handed back, nothing resolved again: the outbox it was decided to be, a pass's exchange or the page
// for a visitor without one, or the page for an upstream that stopped answering between the question and the relay.
export const answerPreview = async (request: IncomingMessage, response: ServerResponse, deps: PreviewDeps): Promise<void> => {
    const handed = request.headers[ANSWER_HEADER];
    if ((handed === PASS || handed === SIGN_IN) && deps.guard !== undefined) {
        if (handed === PASS) {
            await exchangePass(request, response, deps.guard);
        } else {
            signInPage(response, deps.guard, hostOf(request), landingPath(request.url ?? "/"), false);
        }
        return;
    }
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
