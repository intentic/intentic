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

// The stricli application: each command lives in its own src/<command>/<command>.command.ts; this assembles
// them into the route map. Command names + their kebab flags are unchanged.
export const app = buildApplication(
    buildRouteMap({
        routes: {
            init,
            monorepo: monorepoCommand,
            addApp: addAppCommand,
            resolve: resolveCommand,
            plan: planCommand,
            apply,
            destroy,
            adopt,
            restore,
            secrets: secretsCommand,
            deployments: deploymentsCommand,
            logs: logsCommand,
            sandboxTunnel,
            hostSshTunnel,
        },
        docs: { brief: "intentic — intent-driven deployment" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        localization: { loadText: (locale) => (locale.startsWith("en") ? { ...text_en, formatException } : undefined) },
    },
);
