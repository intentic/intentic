/* The entry point the Windows job calls, one command per tier.
 *
 *   node dist/main.js doctor    [--needs-docker]
 *   node dist/main.js install   --installer <path> [--expected-version <version>] [--app-url <url>] [--keep-installed]
 *   node dist/main.js setup     [--sandbox-image <ref>] [--ic-bin <path>] [--web-origin <url>]
 *   node dist/main.js agents    [--turn-seconds <n>]
 *   node dist/main.js teardown
 *
 * Separate commands rather than one run with flags, because they have genuinely different requirements and a
 * CI file should be able to say so: `install` needs no Docker and no credentials and can gate every release;
 * `setup` needs a Docker daemon; `agents` needs a connected account. Collapsing them would mean the cheapest
 * and most valuable tier could only run where the most expensive one can.
 *
 * The exit code is the harness's count and nothing else — a tier that threw is a failure of this file, and one
 * that failed an assertion is a failure of the product; keeping those apart is why nothing here catches.
 */

import { SANDBOX_HOSTNAME } from "./constants.js";
import { runDoctor } from "./doctor.js";
import { createHarness } from "./harness.js";
import { nonEmpty, sandboxContainerName } from "./parse.js";
import { runAgentsTier } from "./tier-agents.js";
import { runInstallTier } from "./tier-install.js";
import { runSetupTier } from "./tier-setup.js";
import { runTeardown } from "./teardown.js";

const flag = (argv: readonly string[], name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
};

const present = (argv: readonly string[], name: string): boolean => argv.includes(`--${name}`);

const USAGE = `usage: main.js doctor|install|setup|agents|teardown [flags] — see the package README`;

const main = async (): Promise<number> => {
    const [command, ...argv] = process.argv.slice(2);
    const harness = createHarness();

    if (command === `doctor`) {
        await runDoctor(harness, { needsDocker: present(argv, `needs-docker`) });
        return harness.report(`the machine is ready`);
    }

    if (command === `install`) {
        const installer = flag(argv, `installer`);
        if (installer === undefined) {
            process.stderr.write(`error: --installer <path to Intentic-setup.exe> is required\n`);
            return 2;
        }
        await runInstallTier(harness, {
            installer,
            expectedVersion: nonEmpty(flag(argv, `expected-version`)),
            appUrl: nonEmpty(flag(argv, `app-url`)),
            keepInstalled: present(argv, `keep-installed`),
        });
        return harness.report(`the Windows installer installs, launches and answers a deep link`);
    }

    if (command === `setup`) {
        await runSetupTier(harness, {
            sandboxImage: flag(argv, `sandbox-image`) ?? `ghcr.io/intentic/sandbox:stable`,
            icBin: flag(argv, `ic-bin`),
            webOrigin: flag(argv, `web-origin`) ?? `https://app.intentic.dev`,
        });
        return harness.report(`the shipped connect.ps1 brings a sandbox up on this Windows machine`);
    }

    if (command === `agents`) {
        // The container's name is DERIVED here rather than threaded from the setup tier through a file: both
        // tiers read it from the one hostname constant, so a rename cannot leave the two disagreeing.
        await runAgentsTier(harness, {
            container: sandboxContainerName(SANDBOX_HOSTNAME),
            agentAuthVolume: nonEmpty(process.env[`INTENTIC_AGENT_AUTH_VOLUME`]),
            turnSeconds: Number(flag(argv, `turn-seconds`) ?? 300),
        });
        return harness.report(`the sandbox is reachable, gated, and runs an /agents turn`);
    }

    if (command === `teardown`) {
        await runTeardown(harness);
        // Always zero: nothing here is news, and a teardown that can go red gives a green run a way to fail
        // for something that already worked.
        harness.report(`the machine is back`);
        return 0;
    }

    process.stderr.write(`${USAGE}\n`);
    return 2;
};

process.exitCode = await main();
