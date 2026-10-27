// SERVE ONLY: starts the demo's dev server the first time anything asks this dev server for /demo, so the hero's live
// frame works under `astro dev` without a second command. Astro's proxy (astro.config.mjs) then forwards to it.
//
// - Lazy: the demo's Vite costs 1.5-1.9 GB, so a dev session that never opens the landing page never pays for it.
// - Reuses one already listening on the port (started by hand with `pnpm -C _site/demo dev`) and starts nothing then.
// - The demo request waits until the port answers (a cold start bundles monaco and friends, which takes minutes), then
//   goes on to the proxy. The child runs in the foreground (INTENTIC_PREVIEW_DIRECT) on the fixed port and stops with
//   this server.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

const DEMO_DEV = join(repoRoot(import.meta.url), "_site/demo/scripts/dev.mjs");
const READY_MS = 6 * 60_000;

const answers = (port) =>
    new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });

const untilAnswers = async (port, child) => {
    const deadline = Date.now() + READY_MS;
    while (Date.now() < deadline) {
        if (await answers(port)) {
            return;
        }
        if (child?.exitCode !== null && child?.exitCode !== undefined) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
};

/** @param {{ port: number }} options */
export const demoDevServer = ({ port }) => ({
    name: "intentic:demo-dev-server",
    apply: "serve",
    configureServer(server) {
        /** @type {Promise<void> | undefined} */
        let ready;
        /** @type {import("node:child_process").ChildProcess | undefined} */
        let child;

        const start = async () => {
            if (await answers(port)) {
                return;
            }
            server.config.logger.info(`[demo] starting the demo's dev server on :${String(port)} for /demo (first start takes a while)`);
            child = spawn(process.execPath, [DEMO_DEV], {
                env: { ...process.env, INTENTIC_PREVIEW_DIRECT: "1" },
                stdio: ["ignore", "inherit", "inherit"],
            });
            child.once("exit", (code) => {
                child = undefined;
                ready = undefined;
                if (code !== 0 && code !== null) {
                    server.config.logger.warn(`[demo] the demo's dev server exited with ${String(code)}; the next /demo request starts it again`);
                }
            });
            await untilAnswers(port, child);
        };

        const stop = () => child?.kill("SIGTERM");
        server.httpServer?.once("close", stop);
        process.once("exit", stop);

        server.middlewares.use((request, _response, next) => {
            if (!request.url?.startsWith("/demo")) {
                return next();
            }
            ready ??= start();
            ready.then(() => next(), next);
            return undefined;
        });
    },
});
