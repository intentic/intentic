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
import { sandboxTunnel } from "./sandbox-tunnel/sandbox-tunnel.command.js";
import { secretsCommand } from "./secrets/secrets.command.js";

// User-facing errors should read as a one-line message, not a JS stack trace — the CLI is driven by end users
// (and by connect.sh inside the sandbox), so a thrown Error renders as "Command failed, <message>". Set
// INTENTIC_DEBUG to keep the stack when chasing an unexpected failure. This overrides stricli's default
// formatter, which prints `error.stack`. The failure is also recorded into the run log's exit footer —
// stricli prints it on STDERR, which the run log's stdout tee never sees; without this a crashed run's log
// reads exactly like a hung run's.
const formatException = (exc: unknown): string => {
    const message = exc instanceof Error ? exc.message : String(exc);
    recordRunFailure(message);
    if (exc instanceof Error) {
        return loadConfig().intenticDebug ? (exc.stack ?? message) : message;
    }
    return message;
};

// The bin is a toolbox, not one tool: three command groups, each its own facet. `tunnel` is core sandbox
// plumbing (used by connect.sh to mint the sandbox's own Cloudflare tunnels); `deploy` is the bundled
// deployment engine (one of many tools an agent can run, not part of the product); `scaffold` seeds app repos.
// Leaf command files keep their own names for run-log/events output (e.g. `apply` still emits command:"apply"),
// so grouping the routes is invisible to the daemon's apply-events tail. Each command lives in its own
// src/<command>/<command>.command.ts.
const tunnel = buildRouteMap({
    routes: {
        sandbox: sandboxTunnel,
        host: hostSshTunnel,
    },
    docs: { brief: "Sandbox reachability — mint the sandbox's own Cloudflare tunnels (used by connect.sh)" },
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
    docs: { brief: "The bundled deployment engine — declare intent, reconcile your own infrastructure" },
});

const scaffold = buildRouteMap({
    routes: {
        monorepo: monorepoCommand,
        addApp: addAppCommand,
    },
    docs: { brief: "Scaffold app repositories — a pnpm+turbo monorepo and its apps" },
});

export const app = buildApplication(
    buildRouteMap({
        routes: { tunnel, deploy, scaffold },
        docs: { brief: "intentic — the sandbox toolbox: tunnel · deploy · scaffold" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        localization: { loadText: (locale) => (locale.startsWith("en") ? { ...text_en, formatException } : undefined) },
    },
);
