import { envSuffix } from "@intentic/sandbox-contract";
import type { ExtensionHost } from "../extensions/installed-extensions.js";
import { brokeredEnvOf, type GitRewrite, gitRewriteEnv, rawRouteEnv, type TurnGateway } from "./broker/broker-env.js";
import type { CredentialDelivery } from "./broker/broker-policy.js";
import { contributionEnv, contributionFor, contributionRegistry } from "./contributions.js";

// The env vars the agent's shell needs for its connected CLI tools, derived from cli-kind capabilities each turn, the
// parallel to mcpToolsOf for the CLI path. Merged into the agent SDK's `env` (see agent.ts). Each connector's env
// template is expanded (contributionEnv) and every var suffixed with the instance id so two of the same provider coexist;
// the per-instance SKILL.md (written by cliHandler.apply) names the exact vars, so the agent never has to guess them.
// Provider data lives in an installed extension's connector (contributionRegistry).
//
// A card whose connector declares a broker gets no credential here at all: its secret-bearing variables hold an inert
// placeholder and its routes' variables hold credential-gateway addresses minted for this conversation
// (broker/broker-env.ts). Only a card the owner explicitly set to raw delivery, or whose connector declares no broker,
// still puts its credential in the environment.

// Marks a card whose credential the gateway holds, by the same suffix as its other variables: what tells the approver
// filter (secrets/credential-gating.ts) that the card's gate is enforced on use, at the gateway, rather than by absence.
export const GATEWAY_MARKER = "CREDENTIAL_GATEWAY";

// One card's git rewrite, carried under the card's own suffix so the persona and approver filters drop it with the rest
// of the card; folded into git's `GIT_CONFIG_*` only once those filters have run (shellEnvOf).
const GIT_REWRITE = "CREDENTIAL_GATEWAY_GIT";

export interface CliEnvOptions {
    readonly gateway: TurnGateway;
    // The owner's delivery choice for a card; a rejection reads as the gateway, never as the raw credential.
    readonly delivery: (capability: string) => Promise<CredentialDelivery>;
}

export const cliEnvOf = async (host: ExtensionHost, options: CliEnvOptions): Promise<Record<string, string>> => {
    const registry = await contributionRegistry(host);
    const env: Record<string, string> = {};
    for (const capability of await host.capabilities.list()) {
        if (capability.kind !== "cli") {
            continue;
        }
        const connector = contributionFor(registry, "cli", capability.config);
        if (connector === undefined) {
            continue;
        }
        const suffix = envSuffix(capability.id);
        // allow(silent-catch): an unreadable policy file reads as gateway delivery, which withholds rather than hands over.
        const delivery = await options.delivery(capability.id).catch((): CredentialDelivery => "gateway");
        const brokered = delivery === "raw" ? undefined : await brokeredEnvOf(connector.spec, capability.config, capability.id, options.gateway);
        const vars = brokered?.env ?? { ...contributionEnv(connector.spec, capability.config), ...rawRouteEnv(connector.spec, capability.config) };
        for (const [key, value] of Object.entries(vars)) {
            env[`${key}_${suffix}`] = value;
        }
        if (brokered !== undefined) {
            env[`${GATEWAY_MARKER}_${suffix}`] = "on";
            brokered.git.forEach((rewrite, index) => {
                env[`${GIT_REWRITE}_${String(index)}_${suffix}`] = `${rewrite.upstream} ${rewrite.gateway}`;
            });
        }
    }
    return env;
};

/** Whether a card's variables in `env` are the gateway's rather than its credential. */
export const gatewayHeld = (env: Readonly<Record<string, string>>, capability: string): boolean =>
    env[`${GATEWAY_MARKER}_${envSuffix(capability)}`] === "on";

/**
 * The environment a turn's shell actually gets from its filtered cli env: every surviving card's git rewrite folded into
 * git's own `GIT_CONFIG_*`. Run after the persona and approver filters, so a card they removed rewrites nothing.
 */
export const shellEnvOf = (cliEnv: Readonly<Record<string, string>>): Record<string, string> => {
    const rewrites: GitRewrite[] = Object.entries(cliEnv)
        .filter(([key]) => key.startsWith(`${GIT_REWRITE}_`))
        .toSorted(([left], [right]) => (left < right ? -1 : 1))
        .flatMap(([, value]) => {
            const [upstream, gateway, ...rest] = value.split(" ");
            return upstream === undefined || gateway === undefined || rest.length > 0 ? [] : [{ upstream, gateway }];
        });
    return { ...cliEnv, ...gitRewriteEnv(rewrites) };
};
