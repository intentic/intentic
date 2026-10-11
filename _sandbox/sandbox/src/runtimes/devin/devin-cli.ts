import { engineMissing } from "../../agent/providers/provider-module.js";
import { engineDescriptor } from "../../engines/engine-descriptors.js";
import { type EngineInstallOutcome, installEngine } from "../../engines/engine-install.js";
import { engineBinary, forgetEngineResolution } from "../../engines/engine-resolve.js";
import type { AcpLaunch } from "../acp/acp-spawn.js";

// Devin's CLI is closed source with no redistribution grant, so no published image carries it: Connect installs the
// pack's pin into the engine store, and the owner's own overlay bakes it once an account is on disk (devin-provider.ts
// `packs`). Resolved through the engine store first, then the image's PATH, where the pack links it.

export const DEVIN_CLI_MISSING = engineMissing("Devin's CLI", "Devin");

// The binary a Devin process runs, or undefined when neither the store nor the image has one: an ordinary state that
// every caller reads as DEVIN_CLI_MISSING.
export const devinCli = (): Promise<string | undefined> => engineBinary("devin");

// Defaults to the engine store's install; parameterized so a suite can exercise miss/install/retry without npm.
export type DevinCliInstall = (id: "devin", version: string) => Promise<EngineInstallOutcome>;

// Process-wide, so two tabs' Connect calls share one download (the binary is ~190 MB); cleared on failure so Retry retries.
let installing: Promise<string> | undefined;

export const ensureDevinCli = async (install: DevinCliInstall = installEngine): Promise<string> => {
    const present = await devinCli();
    if (present !== undefined) {
        return present;
    }
    installing ??= (async () => {
        const version = await engineDescriptor("devin").baked();
        if (version === undefined) {
            throw new Error("The Devin feature pack does not name exactly one CLI version.");
        }
        const outcome = await install("devin", version);
        if (!outcome.ok) {
            throw new Error(`Devin's CLI could not be installed: ${outcome.reason}`);
        }
        forgetEngineResolution("devin");
        const installed = await devinCli();
        if (installed === undefined) {
            throw new Error("Devin's CLI installed, but its binary could not be found.");
        }
        return installed;
    })().finally(() => {
        installing = undefined;
    });
    return installing;
};

// The ACP pool's id for one account's process. One process per account: its sign-in is the process's identity, and the
// pool respawns a process whose launch changed, so a reconnected key reaches the next turn.
export const devinAgentId = (accountId: string): string => `devin:${accountId}`;

// `devin acp`, signed in over the protocol (the key rides `authenticate`'s `_meta.api_key`, which Devin's CLI reads),
// never through WINDSURF_API_KEY: every command the agent runs would inherit an env var. The CLI keeps its sessions in
// its own data directory, so a conversation resumes on any process of this sandbox.
export const devinLaunch = (binary: string, apiKey: string): AcpLaunch => ({
    argv: [binary, "acp"],
    env: {},
    authenticate: { meta: { api_key: apiKey } },
});
