import { errorMessage } from "@intentic/base/errors";
import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { addAppCommand } from "./add-app/add-app.command.js";
import { loadConfig } from "./env.config.js";
import { version } from "./lib/version.js";
import { monorepoCommand } from "./monorepo/monorepo.command.js";
import { hostProbesCli } from "./sandbox-run/host-probes.command.js";
import { sandboxRunCommandCli } from "./sandbox-run/sandbox-run.command.js";

// Renders a thrown Error as a one-line message instead of a stack trace (set INTENTIC_DEBUG to keep the stack).
const formatException = (exc: unknown): string => {
    const message = errorMessage(exc);
    if (exc instanceof Error) {
        return loadConfig().intenticDebug ? (exc.stack ?? message) : message;
    }
    return message;
};

// stricli's own wording is "Command failed, <message>", which prefixes a sentence that already names the problem and
// its fix. FAIL is the word every other intentic tool settles a bad verdict with (docs/ops/cli-output-protocol.md,
// "Verdict words").
const failed = (exc: unknown): string => `FAILED: ${formatException(exc)}`;

// sandbox-run prints the docker-run command connect.sh/recreate.sh execute; hostProbes is the reverse check.
const sandbox = buildRouteMap({
    routes: {
        runCommand: sandboxRunCommandCli,
        hostProbes: hostProbesCli,
    },
    docs: { brief: "The sandbox container's own run contract, print the canonical docker-run command" },
});

const scaffold = buildRouteMap({
    routes: {
        monorepo: monorepoCommand,
        addApp: addAppCommand,
    },
    docs: { brief: "Scaffold app repositories, a pnpm+turbo monorepo and its apps" },
});

export const app = buildApplication(
    buildRouteMap({
        routes: { sandbox, scaffold },
        docs: { brief: "intentic, the sandbox toolbox: sandbox · scaffold" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        localization: {
            loadText: (locale) => (locale.startsWith("en") ? { ...text_en, formatException, exceptionWhileRunningCommand: failed } : undefined),
        },
    },
);
