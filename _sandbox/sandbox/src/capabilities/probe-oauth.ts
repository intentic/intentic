import { PROBE_GRANTS } from "@intentic/extension-manifest";
import { z } from "zod";
import { nodeRequest } from "../system/tls/node-request.js";
import { microsoftEndpoint } from "./sign-in/microsoft-identity.js";

// A card whose credential is a delegated sign-in's refresh token, or an app's own client secret (app-only access), has
// no bearer to test with, so its connection test first trades one for an access token. Both stay in this process's
// memory for the one request; an authority's refusal is said only as a refusal, since its body may echo the credential.
//
// Served for Microsoft's identity platform only, and only for the grants the manifest names (PROBE_GRANTS): a test is a
// read, so it never asks for a person's password. Each cloud pairs one sign-in host with one Graph host, so the test
// goes to the Graph of the cloud the token came from, whatever host the declared URL names: a card can neither aim the
// token it minted elsewhere nor fail its test because two of its fields name different clouds.

// All a token answer is read for; anything else in it (a refresh token, an id token) is never looked at.
const TokenAnswerSchema = z.object({ access_token: z.string().min(1) });

export interface OAuthExchange {
    readonly tokenUrl: string;
    readonly form: Readonly<Record<string, string>>;
}

// The request a signed-in test makes: where it goes, and the bearer it carries.
export interface OAuthProbeTarget {
    readonly url: string;
    readonly token: string;
}

export const probeOAuth = async (oauth: OAuthExchange, declared: string, transport: typeof nodeRequest = nodeRequest): Promise<OAuthProbeTarget> => {
    const endpoint = microsoftEndpoint(oauth.tokenUrl);
    if (endpoint === undefined) {
        throw new Error("Unsupported OAuth probe authority");
    }
    if (!PROBE_GRANTS.some((grant) => grant === oauth.form["grant_type"])) {
        throw new Error("Unsupported OAuth probe grant");
    }
    const { url: authority, graph } = endpoint;
    const path = new URL(declared);
    const url = new URL(`${path.pathname}${path.search}`, `https://${graph}`);
    const response = await transport(authority, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(oauth.form).toString(),
        signal: AbortSignal.timeout(10_000),
        idleMs: 10_000,
        maxBytes: 64 * 1024,
    });
    if (response.status !== 200) {
        throw new Error("OAuth probe refused");
    }
    const answer = TokenAnswerSchema.safeParse(JSON.parse(response.body.toString("utf8")));
    if (!answer.success) {
        throw new Error("OAuth probe returned no token");
    }
    return { url: url.toString(), token: answer.data.access_token };
};
