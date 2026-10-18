import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "node:net";
import type { Logger } from "pino";
import type { QuietWatch } from "../quiet-watch.js";
import { workSignalBody } from "../../workload/work-signal.js";

// Host-only, never routed by netd. The keeper asks this just before stopping the container: work.json is a heartbeat,
// not a certificate that no booking changed since it was written. Failure to obtain a fresh answer forbids sleep.
export const SLEEP_SOCKET_PATH = "/run/intentic/sleep.sock";

const createSleepServer = (quiet: Pick<QuietWatch, "check" | "read">, working: () => number, logger: Pick<Logger, "warn">) =>
    createServer((socket) => {
        socket.setTimeout(10_000, () => socket.destroy());
        socket.on("error", (error) => logger.warn({ err: error }, "sleep probe: host disconnected"));
        void quiet.check().then(
            () => socket.end(workSignalBody(working(), Date.now(), undefined, quiet.read())),
            (error: Error) => {
                logger.warn({ err: error }, "sleep probe: could not confirm sleep");
                socket.end(JSON.stringify({ error: "could not confirm sleep" }));
            },
        );
    });

export const startSleepSocket = async (
    quiet: Pick<QuietWatch, "check" | "read">,
    working: () => number,
    logger: Pick<Logger, "warn">,
    path = SLEEP_SOCKET_PATH,
): Promise<{ readonly close: () => Promise<void> }> => {
    const server = createSleepServer(quiet, working, logger);
    let listening = false;
    try {
        await mkdir(dirname(path), { recursive: true });
        await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") { throw error; } });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(path, () => { server.off("error", reject); resolve(); });
        });
        listening = true;
        await chmod(path, 0o600);
    } catch (error) {
        if (listening) { await new Promise<void>((resolve) => server.close(() => resolve())); }
        listening = false;
        logger.warn({ err: error, path }, "sleep socket unavailable; the host must leave this sandbox awake");
    }
    server.on("error", (error) => logger.warn({ err: error }, "sleep socket failed"));
    return { close: () => listening ? new Promise((resolve) => server.close(() => resolve())) : Promise.resolve() };
};
