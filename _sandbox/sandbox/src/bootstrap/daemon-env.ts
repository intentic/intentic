import { join } from "node:path";
import type { Logger } from "pino";
import { authEnabled } from "../auth/auth-enabled.js";
import type { Config } from "../env.config.js";
import { createLogger } from "../logger.js";
import { logsRoot, terminalLogsDir } from "../logs/log-files.js";
import { adoptDaemonGeneration, DAEMON_ONLY_ENV } from "../seams/workload-stamp.js";
import { claimBootMarker } from "../system/boot/restarts/boot-marker.js";
import { recordBoot } from "../system/boot/restarts/boot-history.js";
import { fileRestartResume } from "../system/restart-resume.js";
import type { ProfileTraits } from "../system/boot/profile.js";

// Runs before the first service exists, so nothing here may depend on one.

// A daemon with no way to verify anybody (no Google client id, no platform identity key and no platform to learn one
// from: auth-enabled.ts) is safe only when it is unreachable; SANDBOX_ALLOW_UNAUTHENTICATED is the one loud exception.
export const requireAuthWhenReachable = (config: Config): void => {
    if (authEnabled(config) || (config.connectToken === "" && config.sandbox.publicUrl === "")) {
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
        "FATAL: this sandbox is externally reachable (CONNECT_TOKEN / SANDBOX_PUBLIC_URL is set) but has no way to verify anyone:\n" +
            "GOOGLE_CLIENT_ID and PLATFORM_IDENTITY_KEY are empty and no platform is configured to learn a key from.\n" +
            "Without one the daemon authenticates nobody and every route: terminals, secrets, the file API, is open to anyone\n" +
            "who can reach the tunnel. Set GOOGLE_CLIENT_ID to the platform's Google web client id and restart.\n",
    );
    process.exit(78); // EX_CONFIG
};

// oRPC's websocket peer tells the far end when a call is abandoned (its signal aborted: a deadline, a turn stopped),
// from inside the signal's listener. When the peer's socket closed first, the send throws there, out of anyone's reach,
// and surfaced as an "uncaught exception" at error, stack and all, 29 times in five days. Nothing is lost: the call it
// would cancel is already over, and the socket that closed is the peer's own business (its heartbeat, its redial).
export const isAbandonedPeerSend = (error: unknown): error is Error =>
    error instanceof Error && error.message === "Cannot send message, WebSocket is not open." && (error.stack ?? "").includes("@orpc/");

// What reached the process's last-resort handlers: a real fault at error with its stack, the known oRPC race at debug.
export const logEscaped = (logger: Pick<Logger, "debug" | "error">, error: unknown, message: string): void => {
    if (isAbandonedPeerSend(error)) {
        logger.debug({ reason: error.message }, "orpc: a call's cancel could not reach a peer whose socket had already closed");
        return;
    }
    logger.error({ err: error }, message);
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
    process.on("unhandledRejection", (reason) => logEscaped(logger, reason, "unhandled rejection"));
    process.on("uncaughtException", (err) => logEscaped(logger, err, "uncaught exception"));
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
 * Takes netd's two socket paths off this process's environment once the netd door has dialled them (2026-10-05):
 * every child inherits what is left, and an agent's shell holding them could start a second Node that takes the
 * netd's socket over. The tmux server's own copy goes with terminal/tmux-server.ts prepareTmuxServer.
 */
export const forgetDaemonOnlyEnv = (env: NodeJS.ProcessEnv = process.env): void => {
    for (const name of DAEMON_ONLY_ENV) {
        delete env[name];
    }
};
