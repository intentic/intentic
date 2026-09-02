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

// User-facing errors should read as a one-line message, not a JS stack trace, the CLI is driven by end users
// (and by connect.sh inside the sandbox), so a thrown Error renders as "Command failed, <message>". Set
// INTENTIC_DEBUG to keep the stack when chasing an unexpected failure. This overrides stricli's default
// formatter, which prints `error.stack`. The failure is also recorded into the run log's exit footer,
// stricli prints it on STDERR, which the run log's stdout tee never sees; without this a crashed run's log
// reads exactly like a hung run's.
const formatException = (exc: unknown): string => {
    const message = errorMessage(exc);
    recordRunFailure(message);
    if (exc instanceof Error) {
        return loadConfig().intenticDebug ? (exc.stack ?? message) : message;
    }
    return message;
};

// The bin is a toolbox, not one tool: three command groups, each its own facet. `tunnel` mints the Cloudflare
// tunnel that lets a sandbox deploy to a machine nothing can dial (connect.sh enrols one with `tunnel host`);
// reaching the SANDBOX itself takes no command at all any more, its daemon dials the ingress from inside.
// `deploy` is the bundled
// deployment engine (one of many tools an agent can run, not part of the product); `scaffold` seeds app repos.
// Leaf command files keep their own names for run-log/events output (e.g. `apply` still emits command:"apply"),
// so grouping the routes is invisible to the daemon's apply-events tail. Each command lives in its own
// src/<command>/<command>.command.ts.
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

// The image speaking its own run contract (see sandbox-run.command.ts): connect.sh/recreate.sh execute what
// this prints instead of hand-copying the docker-run shape. `hostProbes` is the same road in the other
// direction, what the flow must ask its host before running the command.
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
