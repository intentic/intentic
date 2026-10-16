import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import type { Config } from "./env.config.js";

// Real first-party _extensions tree, so a capability fixture resolves against what the daemon ships.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// historyRoot alone is diverted from its default, to a temp dir, so writes stay off the real workspace.
export const testConfig: Config = {
    workspaceRoot: WORKSPACE_ROOT,
    historyRoot: join(tmpdir(), "intentic-test-history"),
    extensionsDir: EXTENSIONS_DIR,
    agentAuthDir: "",
    logLevel: "silent",
    logPretty: false,
    idleStopMinutes: 0,
    zone: "",
    connectToken: "",
    owner: { email: "" },
    syncPairToken: "",
    hostPairToken: "",
    hostPlatform: "",
    hostLabel: "",
    webOrigin: "",
    platform: { url: "", publicKey: "", identityKey: "" },
    intenticAgentTools: "",
    claudeCodeOauthToken: "",
    anthropicApiKey: "",
    openaiApiKey: "",
    cloudflareApiToken: "",
    translator: { url: "", token: "" },
    sandbox: {
        profile: "container",
        port: 8787,
        host: "0.0.0.0",
        publicUrl: "",
        vm: false,
        grant: "",
        allowUnauthenticated: false,
        name: "",
        image: "",
        baseImage: "",
        environmentHash: "",
        channel: "",
        previousImage: "",
        definitionSeed: "",
        devRoot: undefined,
        prewarm: false,
        projectDir: "",
        projectsHost: false,
    },
    // No edge to dial; loopback-only is a supported posture here, not a gap.
    ingress: { url: "" },
    preview: { port: 5173 },
    google: { clientId: "" },
    acmeDirectoryUrl: "",
    intenticAgentModel: "",
    iqModelDir: "",
    iqRgPath: "",
    iqPluginDir: "",
    // Off, which is the shipped default: a plan test must not pay a pre-turn lookup it never asked for.
    iqTurnContext: false,
    webqPluginDir: "",
    local: { port: 8788 },
};
