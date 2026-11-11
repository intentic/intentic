import type { RunnerCredential } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { HarnessCredentialsResult } from "../agent/providers/harness-credentials.js";
import { REQUEST_REFRAMED, RESPONSE_REFRAMED, forwardHeaders } from "../http/forward-headers.js";
import { isTranslatorGatewayUrl } from "../http/translator-gateway-url.js";
import { opt } from "../opt.js";

// A trial marks the answer only when it is one, as the wire has always said it.
const trialOf = (trial: boolean | undefined): true | undefined => (trial === true ? true : undefined);

// LENDING THIS SANDBOX'S MODEL ACCESS TO ITS OWN RUNNERS (runners/runner-credentials.routes.ts), which spend this
// sandbox's providers for the turns it handed them. What travels is the least a turn needs: an access token minted for
// it, a route to dial, or a key that does not rotate. A refresh token never leaves, and neither does the translator's
// own bearer: a runner reaches the translator only through a door that sets that bearer itself. Another of the owner's
// sandboxes is never lent anything (links.md, 2026-11-11): it signs in itself, or takes a static key from the hub.

// Exported for its unit test: every arm is a rule about what leaves the sandbox. `envOauth` travels as an ordinary
// oauth value since resolution answers {} for it; an API-key-shaped fallback stays home instead.
export const toRunnerCredential = (resolved: HarnessCredentialsResult, translatorUrl: string, envOauth: string): RunnerCredential => {
    if (!resolved.ok) {
        return { ok: false, ...opt("code", resolved.code), message: resolved.message };
    }
    const { oauthToken, endpoint, account, trial } = resolved.credentials;
    if (endpoint !== undefined) {
        // The translator's gateway on this daemon's loopback carries the translator's bearer as surely as the translator
        // does, and reaches nothing from a runner's machine: either is the route, never the credential.
        if (translatorUrl !== "" && (endpoint.baseUrl === translatorUrl || isTranslatorGatewayUrl(endpoint.baseUrl))) {
            return { ok: true, kind: "parent-translator", model: endpoint.model, ...opt("trial", trialOf(trial)) };
        }
        return {
            ok: true,
            kind: "endpoint",
            baseUrl: endpoint.baseUrl,
            authToken: endpoint.authToken,
            model: endpoint.model,
            ...opt("trial", trialOf(trial)),
        };
    }
    if (oauthToken !== undefined) {
        return { ok: true, kind: "oauth", accessToken: oauthToken, ...opt("account", account) };
    }
    if (envOauth !== "") {
        return { ok: true, kind: "oauth", accessToken: envOauth };
    }
    return {
        ok: false,
        message: "The origin sandbox has no credential this turn can travel with — connect a Claude account there.",
    };
};

// The borrower's bearer must never reach the translator as the local one, so it goes with the hop-by-hop and reframed
// headers and the translator's own is set in its place. The link header goes too, for the same reason.
const DROPPED_HEADERS = [...REQUEST_REFRAMED, "authorization", "x-intentic-link"];

/**
 * One request relayed to this sandbox's loopback translator, `rest` being the path under the door it arrived at. Streamed
 * both ways, so a long SSE turn is never buffered in memory.
 */
export const forwardToTranslator = async (request: Request, rest: string, translator: { readonly url: string; readonly token: string }): Promise<Response> => {
    if (translator.url === "") {
        return Response.json({ error: "this sandbox has no model translator" }, { status: 503 });
    }
    const search = new URL(request.url).search;
    const headers = forwardHeaders(request.headers, DROPPED_HEADERS);
    headers.set("authorization", `Bearer ${translator.token}`);
    // `duplex` lets fetch send an unmeasured body.
    const init: RequestInit & { duplex?: "half" } = { method: request.method, headers };
    if (request.body !== null) {
        init.body = request.body;
        init.duplex = "half";
    }
    const upstream = await fetch(`${translator.url.replace(/\/$/, "")}${rest}${search}`, init);
    // fetch has decoded the body and the translator's hop-by-hop headers describe its connection to this daemon, so
    // neither its encoding nor its framing goes on to the borrower.
    return new Response(upstream.body, { status: upstream.status, headers: forwardHeaders(upstream.headers, RESPONSE_REFRAMED) });
};
