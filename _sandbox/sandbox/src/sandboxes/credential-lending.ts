import type { RunnerCredential } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { HarnessCredentialsResult } from "../agent/providers/harness-credentials.js";
import { REQUEST_REFRAMED, RESPONSE_REFRAMED, forwardHeaders } from "../http/forward-headers.js";
import { opt } from "../opt.js";

// A trial marks the answer only when it is one, as the wire has always said it.
const trialOf = (trial: boolean | undefined): true | undefined => (trial === true ? true : undefined);

// LENDING THIS SANDBOX'S MODEL ACCESS, the rules both lending doors share: a runner's (runners/runner-credentials.routes.ts),
// which spends this sandbox's providers for the turns it was handed, and an accounts link's (links/accounts/), which
// lends named sign-ins to another of the owner's sandboxes. What travels is the least a turn needs: an access token
// minted for it, a route to dial, or a key that does not rotate. A refresh token never leaves, and neither does the
// translator's own bearer: a borrower reaches the translator only through a door that sets that bearer itself.

// Exported for its unit test: every arm is a rule about what leaves the sandbox. `envOauth` travels as an ordinary
// oauth value since resolution answers {} for it; an API-key-shaped fallback stays home instead. A link passes "" for
// it: the container's own credential is this sandbox's, and is never lent to another.
export const toRunnerCredential = (resolved: HarnessCredentialsResult, translatorUrl: string, envOauth: string): RunnerCredential => {
    if (!resolved.ok) {
        return { ok: false, ...opt("code", resolved.code), message: resolved.message };
    }
    const { oauthToken, endpoint, account, trial } = resolved.credentials;
    if (endpoint !== undefined) {
        if (translatorUrl !== "" && endpoint.baseUrl === translatorUrl) {
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
