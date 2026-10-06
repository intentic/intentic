import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { createLogger } from "../logger.js";
import { logsRoot, terminalLogsDir } from "../logs/log-files.js";
import { adoptDaemonGeneration, DAEMON_ONLY_ENV } from "../seams/workload-stamp.js";
import { claimBootMarker } from "../system/boot/boot-marker.js";
import { recordBoot } from "../system/boot/boot-history.js";
import { fileRestartResume } from "../system/restart-resume.js";
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
    // Before any spawn: every child carries this run's generation, by which a later boot ends what this one left
    // (system/boot/generation-sweep.ts). Fresh each boot, whatever this process inherited.
    adoptDaemonGeneration();
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
        // Counted before anything can fail, so a boot that dies before the gate still counts towards a restart storm,
        // which the boot that finally gets through reads (boot-resumes.ts, work-signal.ts).
        if (bootMarker.claimed) {
            void recordBoot(config.historyRoot, logger, { restartAskedAt: async () => fileRestartResume(config.historyRoot).askedAt?.() });
        }
    }
    return logger;
};

/**
 * Takes the front's two socket paths off this process's environment once the front door has dialled them (2026-10-05):
 * every child inherits what is left, and an agent's shell holding them could start a second Node that takes the
 * front's socket over. The tmux server's own copy goes with terminal/tmux-server.ts prepareTmuxServer.
 */
export const forgetDaemonOnlyEnv = (env: NodeJS.ProcessEnv = process.env): void => {
    for (const name of DAEMON_ONLY_ENV) {
        delete env[name];
    }
};
