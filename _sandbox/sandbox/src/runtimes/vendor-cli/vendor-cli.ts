import type { EngineId } from "@intentic/sandbox-contract/schemas/engines";
import type { NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { engineDescriptor } from "../../engines/engine-descriptors.js";
import { type EngineInstallOutcome, installEngine } from "../../engines/engine-install.js";
import { engineBinary, forgetEngineResolution } from "../../engines/engine-resolve.js";
import type { AcpLaunch } from "../acp/acp-spawn.js";

// A vendor's own coding CLI served as a provider's `vendor` loop over the Agent Client Protocol: Kimi Code CLI
// (runtimes/kimi-cli) and Grok Build (runtimes/grok-build). Both sign in with a device code printed by their own login
// command, keep their tokens (and refresh them) under one home directory an environment variable names, and speak ACP
// over stdio. So each account gets a home of its own under the daemon's auth root, the daemon drives the CLI's login
// into it, and a turn runs the CLI with that home: the CLI's own sign-in, never a credential the daemon re-implements.
// This file is what one CLI must say about itself; the rest of the directory is the machinery both share.

export interface CliDeviceCode {
    readonly url: string;
    readonly code: string;
}

export interface CliIdentity {
    readonly email?: string;
}

export interface VendorCli {
    readonly provider: Extract<NativeProvider, "kimi" | "grok">;
    // What sentences call the program: "Kimi CLI", "Grok Build".
    readonly name: string;
    // The runtime its capability record names, which its adapter claims (runtime-table.ts).
    readonly runtime: "kimi-cli" | "grok-build";
    readonly engine: Extract<EngineId, "kimi" | "grok-build">;
    // The account-door variant its loop signs in under (LoopOffer.door), carried on every row it lists.
    readonly door: string;
    // The directory under the auth root its accounts live in.
    readonly authDir: string;
    // How a process serving one account is started: the ACP command, with the account's home in its environment.
    readonly launch: (binary: string, home: string) => AcpLaunch;
    // The CLI's device-code sign-in: the command that runs it into a home, and the page and code read off its output.
    readonly login: {
        readonly argv: (binary: string) => readonly string[];
        readonly env: (home: string) => Readonly<Record<string, string>>;
        readonly deviceCode: (output: string) => CliDeviceCode | undefined;
    };
    // Who a freshly signed-in home belongs to, best effort: nothing the CLI said is a nameless row, which renaming fixes.
    readonly identity: (home: string) => Promise<CliIdentity>;
}

// The ACP pool's id for one account's process: its home is the process's identity, so one process per account.
export const cliAgentId = (cli: Pick<VendorCli, "runtime">, accountId: string): string => `${cli.runtime}:${accountId}`;

export const cliBinary = (cli: Pick<VendorCli, "engine">): Promise<string | undefined> => engineBinary(cli.engine);

// Why a turn cannot run for want of the program, naming the fix: Connect installs it, a rebuild bakes it.
export const cliMissing = (cli: Pick<VendorCli, "name" | "provider">): string =>
    `${cli.name} isn't installed in this sandbox yet: connect an account for it in Sandbox ▸ Models, which installs it, or rebuild from the Environment card.`;

export type CliInstall = (id: VendorCli["engine"], version: string) => Promise<EngineInstallOutcome>;

// Process-wide per engine, so two tabs' Connect calls share one download; cleared on failure so Retry retries.
const installing = new Map<string, Promise<string>>();

// The binary, installing the pack's pin into the engine store first when neither the store nor the image has one: the
// sign-in is the CLI's own, so it has to be here before an account can be.
export const ensureCli = async (cli: Pick<VendorCli, "engine" | "name">, install: CliInstall = installEngine): Promise<string> => {
    const present = await cliBinary(cli);
    if (present !== undefined) {
        return present;
    }
    const running =
        installing.get(cli.engine) ??
        (async () => {
            const version = await engineDescriptor(cli.engine).baked();
            if (version === undefined) {
                throw new Error(`The ${cli.name} pack does not name exactly one version.`);
            }
            const outcome = await install(cli.engine, version);
            if (!outcome.ok) {
                throw new Error(`${cli.name} could not be installed: ${outcome.reason}`);
            }
            forgetEngineResolution(cli.engine);
            const installed = await cliBinary(cli);
            if (installed === undefined) {
                throw new Error(`${cli.name} installed, but its binary could not be found.`);
            }
            return installed;
        })().finally(() => installing.delete(cli.engine));
    installing.set(cli.engine, running);
    return running;
};
