import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { IdTokenVerifier } from "../auth.js";

// The sandbox authenticates the end user directly against Google; the platform never holds that credential. A person
// whose address no identity provider vouches for comes in on the platform's identity assertion instead, which this
// daemon accepts only where its owner opted that person in (or on a hosted machine the platform holds anyway).
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// What a verified token must say: a verified email. Its display profile rides along when it is text, and is dropped
// (never refused) when it is anything else.
const GoogleClaimsSchema = z.object({
    email: z.string(),
    email_verified: z.literal(true),
    name: z.string().optional().catch(undefined),
    picture: z.string().optional().catch(undefined),
});

export const createGoogleVerifier = (audience: string): IdTokenVerifier => {
    const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    return async (idToken) => {
        // clockTolerance guards clock drift after host sleep; algorithms is pinned so the verifier decides the shape.
        const { payload } = await jwtVerify(idToken, jwks, { issuer: GOOGLE_ISSUERS, audience, clockTolerance: 60, algorithms: ["RS256"] });
        const claims = GoogleClaimsSchema.safeParse(payload);
        if (!claims.success) {
            throw new Error("google id token has no verified email");
        }
        const { email, name, picture } = claims.data;
        return { email, ...opt("name", name), ...opt("picture", picture) };
    };
};
