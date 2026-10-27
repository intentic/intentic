import { z } from "zod";
import { FlyError, flyRequest, flyTokenRejected, isFlyOk } from "./fly.js";

// Mints an app-scoped Fly deploy token per build; the org token (config.hosted.flyApiToken) creates the builder but
// never enters it. The Machines endpoint accepts org deploy tokens, unlike GraphQL's createLimitedAccessToken.
// It returns no revocation id, so these tokens expire after the build timeout plus its reporting grace.
const deployTokenSchema = z.object({ token: z.string().min(1) });

export const mintAppDeployToken = async (token: string, args: { app: string; expiryMinutes: number }): Promise<string> => {
    const response = await flyRequest(`https://api.machines.dev/v1/apps/${encodeURIComponent(args.app)}/deploy_token`, {
        method: `POST`,
        token,
        json: { expiry: `${args.expiryMinutes}m` },
        unanswered: {
            timedOut: (seconds) => `Fly did not create the app deploy token within ${seconds}s`,
            unreachable: (detail) => `Fly could not be reached to create the app deploy token: ${detail}`,
        },
    });
    const rejected = flyTokenRejected(response.status);
    if (rejected !== undefined) {
        throw rejected;
    }
    if (!isFlyOk(response)) {
        throw new FlyError(`Fly could not create the app deploy token (HTTP ${response.status})`, response.status);
    }
    return deployTokenSchema.parse(response.json).token;
};

// Older build rows hold GraphQL token ids; keep revoking those when they finish.

const GRAPHQL = `https://api.fly.io/graphql`;

const graphqlSchema = z.object({
    data: z.unknown().optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
});

const graphql = async (token: string, query: string, variables: Record<string, unknown>): Promise<unknown> => {
    const response = await flyRequest(GRAPHQL, {
        method: `POST`,
        token,
        json: { query, variables },
        unanswered: {
            timedOut: (seconds) => `Fly's GraphQL API did not answer within ${seconds}s`,
            unreachable: (detail) => `Fly's GraphQL API could not be reached: ${detail}`,
        },
    });
    const rejected = flyTokenRejected(response.status);
    if (rejected !== undefined) {
        throw rejected;
    }
    if (!isFlyOk(response)) {
        throw new FlyError(`Fly's GraphQL API answered HTTP ${response.status}`, response.status);
    }
    const parsed = graphqlSchema.parse(response.json);
    if (parsed.errors !== undefined && parsed.errors.length > 0) {
        throw new FlyError(`Fly refused: ${parsed.errors.map((entry) => entry.message).join(`; `)}`);
    }
    return parsed.data;
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
