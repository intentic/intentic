import { z } from "zod";
import { FlyError } from "./fly.js";

/* THE ONE CREDENTIAL A BUILDER MACHINE EVER HOLDS, minted here for each build and nowhere else: a Fly deploy
 * token scoped to the sandbox's own app, alive for a little longer than a build may take, written into the
 * builder as its registry login and thrown away. The org token (config.hosted.flyApiToken) creates the
 * builder and never enters it: a builder runs whatever RUN steps an approved recipe carries, and the whole
 * point of an app-scoped token is that the worst a step which escapes buildkit's sandbox can do with it is
 * push to, or make machines in, the app the recipe's own sandbox already runs inside, for the token's
 * lifetime (hosted-build.ts's reconcile destroys any machine that is neither the sandbox nor the builder).
 *
 * Fly's Machines API mints no tokens; this is its GraphQL API, the same two calls `fly tokens create deploy
 * -a <app>` makes, as plain fetch: the organization's node id by slug, then `createLimitedAccessToken` with
 * the `deploy` profile and the app as its one parameter. Nothing else in the platform speaks GraphQL to Fly,
 * and nothing should: the Machines API is the lane's contract, this is the one exception it forces. */

const GRAPHQL = `https://api.fly.io/graphql`;
const TIMEOUT_MS = 30_000;

// Fly's profile name for a token that may deploy (push to the registry, run machines) in exactly one app.
const DEPLOY_PROFILE = `deploy`;

const graphqlSchema = z.object({
    data: z.unknown().optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
});

const graphql = async (token: string, query: string, variables: Record<string, unknown>): Promise<unknown> => {
    let response: Response;
    try {
        response = await fetch(GRAPHQL, {
            method: `POST`,
            headers: { authorization: `Bearer ${token}`, "content-type": `application/json` },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        throw new FlyError(`Fly's GraphQL API could not be reached: ${error instanceof Error ? error.message : `transport failure`}`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new FlyError(
            `Fly rejected the platform's API token (HTTP ${response.status}): check HOSTED_FLY_API_TOKEN / HOSTED_FLY_ORG.`,
            response.status,
        );
    }
    if (!response.ok) {
        throw new FlyError(`Fly's GraphQL API answered HTTP ${response.status}`, response.status);
    }
    const parsed = graphqlSchema.parse(await response.json());
    if (parsed.errors !== undefined && parsed.errors.length > 0) {
        throw new FlyError(`Fly refused: ${parsed.errors.map((entry) => entry.message).join(`; `)}`);
    }
    return parsed.data;
};

const organizationSchema = z.object({ organization: z.object({ id: z.string() }).nullable() });

// The organization's GraphQL node id, which is what the token mutation wants rather than the slug the config holds.
export const organizationIdOf = async (token: string, orgSlug: string): Promise<string> => {
    const data = organizationSchema.parse(
        await graphql(
            token,
            `
                query ($slug: String!) {
                    organization(slug: $slug) {
                        id
                    }
                }
            `,
            { slug: orgSlug },
        ),
    );
    if (data.organization === null) {
        throw new FlyError(`Fly has no organization named ${orgSlug}: check HOSTED_FLY_ORG.`);
    }
    return data.organization.id;
};

const tokenSchema = z.object({
    createLimitedAccessToken: z.object({ limitedAccessToken: z.object({ id: z.string(), token: z.string() }) }),
});

export interface FlyDeployToken {
    readonly id: string;
    // The bare token: what `docker login registry.fly.io -u x -p <token>` takes.
    readonly token: string;
}

/* A deploy token for ONE app, expiring after `expiryMinutes` (a Go duration on the wire). Named after the
 * build so a leftover in the Fly console says what it was for. `profileParams.app_id` takes the app's name
 * (Fly app ids are their names on this API, which is what flyctl passes there too). */
export const mintAppDeployToken = async (
    token: string,
    organizationId: string,
    args: { app: string; name: string; expiryMinutes: number },
): Promise<FlyDeployToken> => {
    const data = tokenSchema.parse(
        await graphql(
            token,
            `
                mutation ($input: CreateLimitedAccessTokenInput!) {
                    createLimitedAccessToken(input: $input) {
                        limitedAccessToken {
                            id
                            token
                        }
                    }
                }
            `,
            {
                input: {
                    name: args.name,
                    organizationId,
                    profile: DEPLOY_PROFILE,
                    profileParams: { app_id: args.app },
                    expiry: `${args.expiryMinutes}m`,
                },
            },
        ),
    );
    const minted = data.createLimitedAccessToken.limitedAccessToken;
    return { id: minted.id, token: minted.token };
};

// Revoke a build's token early, once the builder has reported: a leaked token then buys nothing at all
// rather than a little longer than a build. Best-effort by contract, the expiry is the guarantee.
export const revokeDeployToken = async (token: string, tokenId: string): Promise<void> => {
    await graphql(
        token,
        `
            mutation ($input: DeleteLimitedAccessTokenInput!) {
                deleteLimitedAccessToken(input: $input) {
                    token
                }
            }
        `,
        {
            input: { id: tokenId },
        },
    );
};
