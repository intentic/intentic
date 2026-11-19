import type { BrokerSessions } from "./broker-session.js";
import type { CredentialPolicyStore } from "./broker-policy.js";
import type { ExtensionHost } from "../extension-inventory/installed-extensions.js";
import { cliEnvOf, shellEnvOf } from "../cli-env.js";
import { gitAccessHook } from "../cli/git-access.js";
import { CORE_CONNECTOR_HOOKS } from "../cli/connector-hooks.js";

// The git the daemon runs by itself (following a remote, the turn-start sync, the Fetch and Pull buttons, Back up)
// reaching a forge whose credential only the credential gateway holds. A turn's shell gets the gateway's
// `url.<gateway>.insteadOf` rewrites from its cli env (../cli-env.ts shellEnvOf); the daemon's own git ran with none, so a
// remote served by an extension's connector (Forgejo, Gitea) failed every fetch on "could not read Username" and was
// never followed (issue #46).
//
// Signed for no conversation, as an automation's guard is (automations/watch/guard-env.ts): a card's rule that asks a
// person, or a card a named approver holds, is refused at the gateway with its reason (broker-gateway.ts), rather than
// raising a card nobody sees, and the fetch fails on that reason instead of hanging.
//
// A card whose credential the daemon's git already reaches another way is left out too: GitHub and GitLab, whose
// connector hook writes the https credential git's store helper reads (../cli/git-access.ts). Moving those onto the
// gateway would put the daemon's fetches and pushes under rules and approvers they have never answered to.

// What it reads off the daemon: the cards and the extensions that declare their connectors, the gateway, and the
// owner's delivery choice for each card.
export interface DaemonGitEnvDeps extends ExtensionHost {
    readonly brokerSessions: Pick<BrokerSessions, "sign">;
    readonly gatewayOrigin: string;
    readonly credentialPolicy: Pick<CredentialPolicyStore, "of">;
}

const hasOwnGitCredential = (provider: string): boolean => CORE_CONNECTOR_HOOKS[provider] === gitAccessHook;

/** Git's environment-borne config for the daemon's own git: only `GIT_CONFIG_*`, empty when no card routes git. */
export const daemonGitEnv = async (services: DaemonGitEnvDeps): Promise<Record<string, string>> => {
    const gateway = { sessions: services.brokerSessions, origin: services.gatewayOrigin, conversationId: undefined };
    const delivery = async (capability: string) => (await services.credentialPolicy.of(capability)).delivery ?? "gateway";
    const installed = await services.capabilities.list();
    const routed = installed.filter((capability) => capability.kind !== "cli" || !hasOwnGitCredential(capability.config.provider));
    const host = { workspace: services.workspace, files: services.files, config: services.config, capabilities: { list: async () => routed } };
    const cliEnv = await cliEnvOf(host, { gateway, delivery });
    return Object.fromEntries(Object.entries(shellEnvOf(cliEnv)).filter(([key]) => key.startsWith("GIT_CONFIG_")));
};

/**
 * `daemonGitEnv`, or none when it cannot be read: a fetch then fails on its own reason, as it did before this env
 * existed, rather than the daemon's git verb throwing on a store it never needed to read.
 */
export const daemonGitEnvOrNone = async (services: DaemonGitEnvDeps): Promise<Record<string, string>> =>
    // allow(silent-catch): an unreadable capability store or policy file leaves the daemon's git exactly as it ran before.
    daemonGitEnv(services).catch((): Record<string, string> => ({}));
