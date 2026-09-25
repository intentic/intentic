import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { createLogger } from "../logger.js";
import { logsRoot, terminalLogsDir } from "../logs/log-files.js";
import { claimBootMarker } from "../system/boot/boot-marker.js";
import type { ProfileTraits } from "../system/boot/profile.js";

// Runs before the first service exists, so nothing here may depend on one.

// An empty google.clientId is safe only when this daemon is unreachable; SANDBOX_ALLOW_UNAUTHENTICATED is the one loud exception.
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
    // Before the logger: must be legible in `docker logs` even when log config is what went wrong.
    process.stderr.write(
        "FATAL: this sandbox is externally reachable (CONNECT_TOKEN / SANDBOX_PUBLIC_URL is set) but GOOGLE_CLIENT_ID is empty.\n" +
            "Without it the daemon authenticates nobody and every route: terminals, secrets, the file API, is open to anyone\n" +
            "who can reach the tunnel. Set GOOGLE_CLIENT_ID to the platform's Google web client id and restart.\n",
    );
    process.exit(78); // EX_CONFIG
};

export const prepareDaemonProcess = (config: Config, traits: ProfileTraits): Logger => {
    if (!traits.sharedTmux) {
        // Defaulted, not forced, so an operator can override.
        process.env["INTENTIC_AGENT_TMUX"] ??= "0";
    }
    process.env["INTENTIC_LOG_DIR"] ??= join(logsRoot(config.historyRoot), "intentic-runs");
    // bin/tmux-run and the output filter must agree where raw pane logs live.
    process.env["INTENTIC_TERMINAL_LOGS_DIR"] ??= terminalLogsDir(config.historyRoot);
    const logger = createLogger(config);
    // The daemon must stay up for /agent and /events when a best-effort boot job rejects; a bad config still crashes loudly.
    process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled rejection"));
    process.on("uncaughtException", (err) => logger.error({ err }, "uncaught exception"));
    // Skipped with no history volume (dev, tests).
    if (config.historyRoot !== "") {
        const bootMarker = claimBootMarker(logsRoot(config.historyRoot), logger);
        process.on("exit", (code) => bootMarker.markExited(code));
    }
    return logger;
};
