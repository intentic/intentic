// One command per tier (doctor, install, setup, agents, teardown), separate rather than flags since each needs
// different things (install needs no Docker; agents needs a connected account). The exit code is only the harness's
// failure count; nothing here catches, so a thrown error and a failed assertion stay distinguishable.

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

const USAGE = `usage: main.js doctor|install|setup|agents|teardown [flags], see the package README`;

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
            process.stderr.write(`error: --installer <path to Intentic-<version>-x64-setup.exe> is required\n`);
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
        // Container name derived here, not threaded from the setup tier: both tiers read the same hostname constant.
        await runAgentsTier(harness, {
            container: sandboxContainerName(SANDBOX_HOSTNAME),
            agentAuthVolume: nonEmpty(process.env[`INTENTIC_AGENT_AUTH_VOLUME`]),
            turnSeconds: Number(flag(argv, `turn-seconds`) ?? 300),
        });
        return harness.report(`the sandbox is reachable, gated, and runs an /agents turn`);
    }

    if (command === `teardown`) {
        await runTeardown(harness);
        // Always zero: nothing here is news, and a red teardown would fail a green run for something already working.
        harness.report(`the machine is back`);
        return 0;
    }

    process.stderr.write(`${USAGE}\n`);
    return 2;
};

process.exitCode = await main();
