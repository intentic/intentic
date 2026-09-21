import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { createLogger } from "../logger.js";
import { logsRoot, terminalLogsDir } from "../logs/log-files.js";
import { claimBootMarker } from "../platform/boot/boot-marker.js";
import type { ProfileTraits } from "../platform/boot/profile.js";

// The process a daemon is built on: the one refusal that must happen before anything else, the env every spawned child
// inherits, the handlers that keep a rejection from taking the daemon down, and the marker that names the last run's
// death. All of it runs before the first service exists, so nothing here may depend on one.

// Refuses to serve unauthenticated: an empty google.clientId is safe only when this daemon is unreachable. Reachable
// with it empty opens every gate in app.ts silently; SANDBOX_ALLOW_UNAUTHENTICATED is the one loud exception.
export const requireAuthWhenReachable = (config: Config): void => {
    if (config.google.clientId !== "" || (config.connectToken === "" && config.sandbox.publicUrl === "")) {
        return;
    }
    if (config.sandbox.allowUnauthenticated) {
        process.stderr.write(
            "WARNING: SANDBOX_ALLOW_UNAUTHENTICATED is set, this daemon is reachable (CONNECT_TOKEN / SANDBOX_PUBLIC_URL)\n" +
                "and authenticates NOBODY: terminals, secrets and the file API answer any caller that reaches this port.\n" +
                "Only the e2e harnesses set this. If you are not one of them, unset it and set GOOGLE_CLIENT_ID instead.\n",
        );
        return;
    }
    // Before the logger: this must be legible in `docker logs` even when log config is part of what went wrong.
    process.stderr.write(
        "FATAL: this sandbox is externally reachable (CONNECT_TOKEN / SANDBOX_PUBLIC_URL is set) but GOOGLE_CLIENT_ID is empty.\n" +
            "Without it the daemon authenticates nobody and every route: terminals, secrets, the file API, is open to anyone\n" +
            "who can reach the tunnel. Set GOOGLE_CLIENT_ID to the platform's Google web client id and restart.\n",
    );
    process.exit(78); // EX_CONFIG
};

// Settles the process, then hands back the logger every later phase writes through.
export const prepareDaemonProcess = (config: Config, traits: ProfileTraits): Logger => {
    if (!traits.sharedTmux) {
        // No shared tmux server for agent commands; defaults INTENTIC_AGENT_TMUX off, not forced, so an operator can
        // override.
        process.env["INTENTIC_AGENT_TMUX"] ??= "0";
    }
    // intentic CLI runs spawned here tee output to the daemon-owned logs tree via INTENTIC_LOG_DIR.
    process.env["INTENTIC_LOG_DIR"] ??= join(logsRoot(config.historyRoot), "intentic-runs");
    // Inherited by bin/tmux-run and the output filter via the agent env, so both agree where raw pane logs live.
    process.env["INTENTIC_TERMINAL_LOGS_DIR"] ??= terminalLogsDir(config.historyRoot);
    const logger = createLogger(config);
    // Logs and continues rather than exiting: the daemon must stay up for /agent and /events even when a best-effort
    // boot job rejects. The config-load throw above this stays unguarded on purpose; a bad config should crash loudly.
    process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled rejection"));
    process.on("uncaughtException", (err) => logger.error({ err }, "uncaught exception"));
    // Names the previous run's unannounced death (with its fatal report, if V8 wrote one) and stamps this run's marker;
    // the exit hook flips it to "exited" on a deliberate stop. Skipped with no history volume (dev, tests).
    if (config.historyRoot !== "") {
        const bootMarker = claimBootMarker(logsRoot(config.historyRoot), logger);
        process.on("exit", (code) => bootMarker.markExited(code));
    }
    return logger;
};
