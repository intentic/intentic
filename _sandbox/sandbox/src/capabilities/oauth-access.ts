import type { CapabilitiesStore } from "./capabilities-store.js";
import type { ResolvedContribution } from "./contributions.js";
import { ORPCError } from "@orpc/server";
import type { Config } from "../env.config.js";
import { callIngress, type IngressAnswer } from "../system/platform-client.js";
import { signInCard } from "./refresh-token.js";

// An hour of access token for a card signed in through the platform's own OAuth client (a field declaring `signIn`),
// whose refresh needs the client secret only the platform holds. The daemon reads the card's own refresh token and
// spends this sandbox's connect token on the platform's door, so the caller (the card's CLI with the agent token, or
// its listener process with its extension token) names a card and never handles either credential. Nothing is stored:
// the CLI caches the access token itself, as it does one it minted on its own client.

export interface AccessToken {
    readonly accessToken: string;
    readonly expiresIn: number;
}

// The platform's door for a provider's refresh, as the daemon calls it: undefined data with a refusal on a refused trade.
export type AccessDoor = (refreshToken: string) => Promise<IngressAnswer<AccessToken>>;

export const platformDoor =
    (config: Config): AccessDoor =>
    async (refreshToken) => {
        if (config.platform.url === "" || config.connectToken === "") {
            throw new ORPCError("BAD_GATEWAY", { status: 502, message: "this sandbox is not connected to a platform, which holds the sign-in's client" });
        }
        // One provider today, so one platform door; a second provider adds its own route beside this one.
        return callIngress(config, { route: "googleAccessToken", input: { refreshToken }, idleMs: 30_000 }).catch(() => {
            // allow(silent-catch): an unreachable platform is said as one; the CLI keeps any token it cached.
            throw new ORPCError("BAD_GATEWAY", { status: 502, message: "the platform could not be reached to refresh the sign-in" });
        });
    };

export const mintPlatformAccess = async (
    store: Pick<CapabilitiesStore, "get" | "list">,
    registry: ReadonlyMap<string, ResolvedContribution>,
    door: AccessDoor,
    id: string,
    // The extension a listener process calls as; undefined for the agent's own CLI.
    caller: string | undefined,
): Promise<AccessToken> => {
    const target = await signInCard(store, registry, id);
    if (caller !== undefined && caller !== target.extension) {
        throw new ORPCError("FORBIDDEN", { message: `"${target.card.id}" is not a connection extension "${caller}" contributes` });
    }
    // Only a provider whose sign-in runs on the platform's own client refreshes there; another `signIn` provider keeps
    // its refresh token on the card's own client and mints for itself.
    if (target.spec.fields.find((field) => field.key === target.declared.field)?.signIn !== "google") {
        throw new ORPCError("NOT_FOUND", { message: `"${target.card.id}" does not sign in through the platform` });
    }
    const refreshToken = target.card.config[target.declared.field] ?? "";
    if (refreshToken === "") {
        throw new ORPCError("CONFLICT", { message: `"${target.card.id}" has not been signed in yet: use the sign-in button on its card` });
    }
    const answer = await door(refreshToken);
    if (answer.data !== undefined) {
        return answer.data;
    }
    // The platform's refusal is the provider's own protocol code (`invalid_grant`) or its own sentence; relayed as is,
    // since the CLI is what turns it into what the owner does about it.
    const refused = answer.status === 400;
    throw new ORPCError(refused ? "BAD_REQUEST" : "BAD_GATEWAY", {
        status: refused ? 400 : 502,
        message: answer.refusal ?? `the platform answered HTTP ${answer.status}`,
    });
};
