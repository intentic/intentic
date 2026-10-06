import type { CapabilityContribution } from "@intentic/extension-manifest";
import { contributionEnv } from "../contributions.js";
import { brokerOf, brokerRoutes, GATEWAY_PLACEHOLDER, secretBearingEnv } from "./broker-routes.js";
import type { BrokerSessions } from "./broker-session.js";

// What a brokered card puts in a turn's environment: its connector's `env` as ever, except that every variable carrying
// a secret holds the inert placeholder, and each route's variable holds a gateway address minted for this conversation.
// A route serving git also rewrites the agent's git onto the gateway for its upstream, so clone, fetch and push need no
// credential in the agent's hands. Nothing here is a secret: the addresses work only on this container's loopback, only
// for the card and upstream signed into them, and only through every check the gateway makes.

// Where the gateway listens, as the agent's shell dials it.
export interface TurnGateway {
    readonly sessions: Pick<BrokerSessions, "sign">;
    // `http://127.0.0.1:<port>`, no trailing slash.
    readonly origin: string;
    // Whose requests the addresses carry; absent for one minted outside any conversation, which no card can be raised in.
    readonly conversationId: string | undefined;
}

// `url.<gateway>.insteadOf <upstream>`: git's own longest-prefix rewrite, given through the environment
// (`GIT_CONFIG_COUNT`), so it applies to every git the turn runs without a file anyone could edit or forget.
export interface GitRewrite {
    readonly gateway: string;
    readonly upstream: string;
}

export interface BrokeredEnv {
    // Unsuffixed names; the caller applies the per-instance suffix as it does for every other connector variable.
    readonly env: Readonly<Record<string, string>>;
    readonly git: readonly GitRewrite[];
}

/** The env of a card whose connector declares a broker, or undefined when it declares none. */
export const brokeredEnvOf = async (
    spec: CapabilityContribution,
    config: Readonly<Record<string, string>>,
    capability: string,
    gateway: TurnGateway,
): Promise<BrokeredEnv | undefined> => {
    const broker = brokerOf(spec);
    if (broker === undefined) {
        return undefined;
    }
    const env: Record<string, string> = { ...contributionEnv(spec, config) };
    for (const name of secretBearingEnv(spec)) {
        env[name] = GATEWAY_PLACEHOLDER;
    }
    const git: GitRewrite[] = [];
    for (const route of brokerRoutes(broker, config)) {
        const token = await gateway.sessions.sign({
            capability,
            route: route.index,
            upstream: route.upstream.href,
            conversationId: gateway.conversationId,
        });
        const address = `${gateway.origin}/${token}`;
        if (route.env !== undefined) {
            env[route.env] = address;
        }
        if (route.git) {
            const base = route.upstream.href.endsWith("/") ? route.upstream.href : `${route.upstream.href}/`;
            git.push({ gateway: `${address}/`, upstream: base });
            // Both ssh spellings of the same remote, for a service at the root of its host: `git@github.com:owner/repo`
            // and `ssh://git@github.com/owner/repo`. A turn's git reaches the account only here, where the card's rules
            // apply: the sandbox's ssh agent keeps the account's own ssh key for the owner's terminal.
            if (route.upstream.pathname === "/") {
                git.push({ gateway: `${address}/`, upstream: `git@${route.upstream.hostname}:` });
                git.push({ gateway: `${address}/`, upstream: `ssh://git@${route.upstream.hostname}/` });
            }
        }
    }
    return { env, git };
};

/**
 * A card the owner set to raw delivery still gets its routes' variables, holding the service's own address (with any
 * path-borne credential in it), so a skill written against the variables works in either mode: the credential then rides
 * the headers the skill sends itself.
 */
export const rawRouteEnv = (spec: CapabilityContribution, config: Readonly<Record<string, string>>): Record<string, string> => {
    const broker = brokerOf(spec);
    const env: Record<string, string> = {};
    for (const route of broker === undefined ? [] : brokerRoutes(broker, config)) {
        if (route.env !== undefined) {
            env[route.env] = `${route.upstream.origin}${route.upstream.pathname === "/" ? "" : route.upstream.pathname}${route.pathPrefix}`;
        }
    }
    return env;
};

/** Git's environment-borne config for a set of rewrites; empty when there are none. */
export const gitRewriteEnv = (rewrites: readonly GitRewrite[]): Record<string, string> => {
    if (rewrites.length === 0) {
        return {};
    }
    const env: Record<string, string> = { GIT_CONFIG_COUNT: String(rewrites.length) };
    rewrites.forEach((rewrite, index) => {
        env[`GIT_CONFIG_KEY_${String(index)}`] = `url.${rewrite.gateway}.insteadOf`;
        env[`GIT_CONFIG_VALUE_${String(index)}`] = rewrite.upstream;
    });
    return env;
};
