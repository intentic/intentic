import type { Services } from "../composition.js";
import { extensionEnvOf } from "../extensions/extension-env.js";
import { extensionBinDirsOf } from "../extensions/installed-extensions.js";
import { cliEnvOf } from "./cli-env.js";

// The environment a turn's shell runs with: connected cli capabilities' variables (credential-gateway addresses for every
// brokered card, the credential itself only for one delivered raw), extension settings env, and extension bin dirs on
// PATH. Shared by streamAgent and the watch restore in agent/watchers.ts so both derive the same environment. Read live,
// never stored, so a rotated or revoked credential is always current. `conversationId` is whose requests the gateway
// addresses answer to: its gates, its cards, its ledger rows.
export const turnCliEnv = async (services: Services, conversationId: string | undefined): Promise<Record<string, string>> => {
    const gateway = { sessions: services.brokerSessions, origin: services.gatewayOrigin, conversationId };
    const delivery = async (capability: string) => (await services.credentialPolicy.of(capability)).delivery ?? "gateway";
    // cli capabilities contribute their variables; `contributes.settings.env` extensions add theirs too.
    const env = { ...(await cliEnvOf(services, { gateway, delivery })), ...(await extensionEnvOf(services)) };
    // Extensions shipping `contributes.bin` get their bin dir prepended so the tool resolves by name.
    const binDirs = await extensionBinDirsOf(services);
    if (binDirs.length > 0) {
        env["PATH"] = [...binDirs, process.env["PATH"] ?? ""].filter((entry) => entry !== "").join(":");
    }
    return env;
};
