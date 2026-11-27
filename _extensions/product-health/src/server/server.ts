import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionServerApi, ExtensionServerContext, ServerActivation } from "@intentic/extension-api";
import { daemonOf } from "./daemon.js";
import { doorOf } from "./door.js";
import type { Workspace } from "./joins.js";
import { postHogClient } from "./posthog.js";
import { routesOf } from "./routes.js";
import { createService } from "./service.js";
import { STATE_FILE, stateOptions } from "./state.js";
import { toolsOf } from "./tools.js";

/* THE BACKEND'S ACTIVATION (dist/server.js, run by the daemon's extension host): reads every PostHog connection on a
   schedule, serves the view's snapshot and presses under /x/<id>, the agent's `findings` tools, and the door PostHog's
   alerts post to; hears its fix agents' runs end for the `Owner step:` they close on. */

// git without a pager or a prompt, so a read never waits on a terminal nobody is at.
const QUIET_ENV = { ...process.env, GIT_TERMINAL_PROMPT: `0`, GIT_PAGER: `cat`, LC_ALL: `C` };
const GIT_TIMEOUT_MS = 20_000;

const git = (dir: string, args: readonly string[]): Promise<string> =>
    new Promise((resolve, reject) => {
        execFile(`git`, [...args], { cwd: dir, env: QUIET_ENV, maxBuffer: 32 * 1024 * 1024, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
            if (error !== null) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });

export const activateServer = (api: ExtensionServerApi, context?: ExtensionServerContext): ServerActivation => {
    const daemon = daemonOf(api.daemon);
    const workspace: Workspace = {
        repos: () => daemon.repos(),
        dirOf: (repo) => (repo === `root` ? api.workspaceRoot : join(api.workspaceRoot, repo)),
        git,
        read: (path) => readFile(path, `utf8`),
    };
    const state = api.document(STATE_FILE, stateOptions);
    const service = createService({
        daemon,
        state,
        workspace,
        clientOf: (connection) => postHogClient(connection),
        now: Date.now,
        log: api.log,
        extensionId: context?.extensionId ?? `intentic.product-health`,
    });
    api.routes.mount(routesOf(service, (request) => api.caller(request)));
    api.tools.serve(() => toolsOf(service, Date.now));
    api.publicRoutes.serve(doorOf(async () => (await state.read()).hookToken, service.nudge));
    const settled = api.events.onRunSettled((run) => void service.settled(run));
    service.start();
    return {
        deactivate: () => {
            service.stop();
            settled.dispose();
        },
        health: service.health,
    };
};
