import type { Services } from "../../../composition.js";
import { documentSearchEnv } from "../../../derived/search-env.js";
import { extensionEnvOf } from "../../../extensions/extension-env.js";
import { extensionBinDirsOf } from "../../../capabilities/extension-inventory/installed-extensions.js";
import { cliEnvOf } from "../../../capabilities/cli-env.js";

// Where this conversation's ssh asks for signatures (broker/ssh-agent.ts): set over whatever the daemon's own environment
// says, so a turn never reaches the owner's socket. Absent while the sandbox holds no key, so a sandbox without ssh
// machines binds nothing; a key added mid-conversation is reachable from its next turn.
const sshAgentEnv = async (services: Services, conversationId: string | undefined): Promise<Record<string, string>> => {
    // allow(silent-catch): an unreadable key store holds nothing this turn could sign with.
    if ((await services.sshKeys.aliases().catch((): readonly string[] => [])).length === 0) {
        return {};
    }
    const socket = await services.sshAgent.forConversation(conversationId);
    return socket === undefined ? {} : { SSH_AUTH_SOCK: socket };
};

// The environment a turn's shell runs with: connected cli capabilities' variables (credential-gateway addresses for every
// brokered card, the credential itself only for one delivered raw), extension settings env, extension bin dirs on PATH,
// the conversation's own ssh agent socket, and the ripgrep config that makes `rg` search documents. Shared by streamAgent and the watch restore in agent/watchers.ts so both
// derive the same environment. Read live, never stored, so a rotated or revoked credential is always current.
// `conversationId` is whose requests the gateway addresses and the ssh agent answer to: its gates, its cards, its
// ledger rows.
export const turnCliEnv = async (services: Services, conversationId: string | undefined): Promise<Record<string, string>> => {
    const gateway = { sessions: services.brokerSessions, origin: services.gatewayOrigin, conversationId };
    const delivery = async (capability: string) => (await services.credentialPolicy.of(capability)).delivery ?? "gateway";
    // cli capabilities contribute their variables; `contributes.settings.env` extensions add theirs too.
    const env = {
        ...(await cliEnvOf(services, { gateway, delivery })),
        ...(await extensionEnvOf(services)),
        ...(await sshAgentEnv(services, conversationId)),
        // `rg` reading documents through fileq, while the keeper keeps their shadows (derived/search-env.ts).
        ...(await documentSearchEnv((await services.sandboxSettings.get()).documentSearch)),
    };
    // Extensions shipping `contributes.bin` get their bin dir prepended so the tool resolves by name.
    const binDirs = await extensionBinDirsOf(services);
    if (binDirs.length > 0) {
        env["PATH"] = [...binDirs, process.env["PATH"] ?? ""].filter((entry) => entry !== "").join(":");
    }
    return env;
};
