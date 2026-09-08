import { z } from "zod";
import { FlyError } from "./fly.js";

// Mints an app-scoped Fly deploy token per build; the org token (config.hosted.flyApiToken) creates the builder but
// never enters it, so an escaped RUN step can at worst touch the recipe's own app for the token's lifetime. Uses Fly's
// GraphQL API, the one exception to the Machines API contract.

const GRAPHQL = `https://api.fly.io/graphql`;
const TIMEOUT_MS = 30_000;

// Fly's token profile for a token that may deploy (push to the registry, run machines) in exactly one app.
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

// The organization's GraphQL node id, which the token mutation needs instead of the slug the config holds.
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

// A deploy token for one app, expiring after `expiryMinutes` (a Go duration on the wire), named after the build.
// `profileParams.app_id` takes the app's name (Fly app ids are names on this API).
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

// Revokes a build's token early once the builder has reported, so a leaked token buys nothing. Best-effort; the expiry
// is the actual guarantee.
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
