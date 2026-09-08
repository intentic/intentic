import { errorMessage } from "@intentic/base/errors";
import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { addAppCommand } from "./add-app/add-app.command.js";
import { adopt } from "./adopt/adopt.command.js";
import { apply } from "./apply/apply.command.js";
import { deploymentsCommand } from "./deployments/deployments.command.js";
import { destroy } from "./destroy/destroy.command.js";
import { loadConfig } from "./env.config.js";
import { hostSshTunnel } from "./host-ssh-tunnel/host-ssh-tunnel.command.js";
import { init } from "./init/init.command.js";
import { version } from "./lib/version.js";
import { recordRunFailure } from "./lib/run-log.js";
import { logsCommand } from "./logs/logs.command.js";
import { monorepoCommand } from "./monorepo/monorepo.command.js";
import { planCommand } from "./plan/plan.command.js";
import { resolveCommand } from "./resolve/resolve.command.js";
import { restore } from "./restore/restore.command.js";
import { hostProbesCli } from "./sandbox-run/host-probes.command.js";
import { sandboxRunCommandCli } from "./sandbox-run/sandbox-run.command.js";
import { secretsCommand } from "./secrets/secrets.command.js";

// Renders a thrown Error as a one-line message instead of a stack trace (set INTENTIC_DEBUG to keep the
// stack). Also records the failure to the run log, since stricli prints to stderr, which the log's stdout tee misses.
const formatException = (exc: unknown): string => {
    const message = errorMessage(exc);
    recordRunFailure(message);
    if (exc instanceof Error) {
        return loadConfig().intenticDebug ? (exc.stack ?? message) : message;
    }
    return message;
};

// Grouping routes doesn't rename leaf commands; each emits its own command name in run-log/events output.
const tunnel = buildRouteMap({
    routes: {
        host: hostSshTunnel,
    },
    docs: { brief: "Deploy-target reachability, mint a host's own Cloudflare SSH tunnel (used by connect.sh)" },
});

const deploy = buildRouteMap({
    routes: {
        init,
        resolve: resolveCommand,
        plan: planCommand,
        apply,
        destroy,
        adopt,
        restore,
        secrets: secretsCommand,
        deployments: deploymentsCommand,
        logs: logsCommand,
    },
    docs: { brief: "The bundled deployment engine, declare intent, reconcile your own infrastructure" },
});

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
        routes: { tunnel, sandbox, deploy, scaffold },
        docs: { brief: "intentic, the sandbox toolbox: tunnel · sandbox · deploy · scaffold" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        localization: { loadText: (locale) => (locale.startsWith("en") ? { ...text_en, formatException } : undefined) },
    },
);
