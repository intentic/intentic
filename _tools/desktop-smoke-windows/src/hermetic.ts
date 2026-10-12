import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_IDENTIFIER } from "./constants.js";

export interface HermeticDesktop {
    readonly appUrl: string;
    readonly workspaceInspectable: boolean;
    readonly workspaceRequested: () => boolean;
    readonly setupStarted: () => boolean;
    readonly close: () => Promise<void>;
}

const listen = async (server: Server): Promise<number> =>
    await new Promise<number>((resolve, reject) => {
        server.once(`error`, reject);
        server.listen(0, `127.0.0.1`, () => {
            server.off(`error`, reject);
            const address = server.address();
            if (address === null || typeof address === `string`) {
                reject(new Error(`the local desktop stub did not bind a TCP port`));
                return;
            }
            resolve(address.port);
        });
    });

const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) {
        delete process.env[key];
        return;
    }
    process.env[key] = value;
};

/* THE FILES THE APP DECIDES A BARE LAUNCH BY, pinned for the run and put back after it (2026-10-12). The runner is a PC
 * that is also used, by its owner's own installs and by the nightly's deeper tiers, which connect real sandboxes, and an
 * uninstall leaves the app's config directory where it is: so whatever that directory last held decided which window
 * this tier's launch opened. A PC that hosts sandboxes, launched while Docker Desktop is down (it does not start itself
 * at sign-in), opens This device for the engine rather than the workspace (lib.rs `opening`), and the launch's check of
 * the workspace page waited out its 30 seconds for a request that was never coming (run 38301566644, after the run
 * before it lost its runner mid-tier). `undefined` names a file that must not exist. */
export const launchState = (workspaceUrl: string, platformUrl: string): ReadonlyMap<string, string | undefined> =>
    new Map([
        // Settings come before environment defaults in the app, so a developer setting kept across an uninstall would win.
        [`settings.json`, JSON.stringify({ appUrl: workspaceUrl, platformUrl }, undefined, 2)],
        // The face a bare launch opens (state.rs `Face`): the workspace, which is what the launch section checks.
        [`last-face.json`, JSON.stringify(`workspace`)],
        // No sandbox hosted here, so the launch never waits on this PC's engine.
        [`hosts-sandboxes.json`, JSON.stringify(false)],
        // No setup an earlier run left parked: one outranks every other face at launch.
        [`resume-setup.json`, undefined],
    ]);

// Writes each file as `files` says (or removes it), and answers what puts every one back exactly as it was.
export const pinFiles = async (directory: string, files: ReadonlyMap<string, string | undefined>): Promise<() => Promise<void>> => {
    await mkdir(directory, { recursive: true });
    const put = async (name: string, content: string | Buffer | undefined): Promise<void> => {
        const path = join(directory, name);
        await (content === undefined ? rm(path, { force: true }) : writeFile(path, content));
    };
    const before = new Map<string, Buffer | undefined>();
    for (const [name, content] of files) {
        const path = join(directory, name);
        before.set(name, existsSync(path) ? await readFile(path) : undefined);
        await put(name, content);
    }
    return async () => {
        for (const [name, content] of before) {
            await put(name, content);
        }
    };
};

/* The cold OS launch inherits this process's environment through PowerShell's Start-Process. */
export const prepareHermeticDesktop = async (configuredAppUrl: string | undefined): Promise<HermeticDesktop> => {
    let workspaceRequested = false;
    const server = createServer((request, response) => {
        if (request.method === `GET`) {
            workspaceRequested = true;
        }
        response.writeHead(200, { "content-type": `text/html; charset=utf-8`, "cache-control": `no-store`, connection: `close` });
        response.end(`<!doctype html><html><head><title>Intentic smoke workspace</title></head><body>ready</body></html>`);
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const workspaceUrl = configuredAppUrl ?? origin;
    const directory = await mkdtemp(join(tmpdir(), `intentic-desktop-smoke-`));
    const marker = join(directory, `setup-started`);
    const docker = join(directory, `docker.cmd`);
    const ic = join(directory, `ic.cmd`);
    await writeFile(docker, `@echo off\r\nexit /b 0\r\n`);
    await writeFile(ic, `@echo off\r\n> "${marker}" echo started\r\nexit /b 1\r\n`);

    // Written where the installed app reads them (its Tauri config directory), so the cold launch is this run's own
    // whatever the runner kept across an uninstall (launchState).
    const appData = process.env[`APPDATA`];
    if (appData === undefined || appData === ``) {
        throw new Error(`APPDATA is unavailable; the installed app's settings location cannot be prepared`);
    }
    const restoreState = await pinFiles(join(appData, APP_IDENTIFIER), launchState(workspaceUrl, origin));

    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === `path`) ?? `Path`;
    const previous = {
        path: process.env[pathKey],
        appUrl: process.env[`INTENTIC_APP_URL`],
        platformUrl: process.env[`INTENTIC_PLATFORM_URL`],
        icBin: process.env[`IC_BIN`],
        disableUpdateCheck: process.env[`INTENTIC_DISABLE_UPDATE_CHECK`],
    };
    process.env[pathKey] = `${directory};${previous.path ?? ``}`;
    process.env[`INTENTIC_APP_URL`] = workspaceUrl;
    process.env[`INTENTIC_PLATFORM_URL`] = origin;
    process.env[`IC_BIN`] = ic;
    process.env[`INTENTIC_DISABLE_UPDATE_CHECK`] = `1`;

    return {
        appUrl: workspaceUrl,
        workspaceInspectable: configuredAppUrl === undefined,
        workspaceRequested: () => workspaceRequested,
        setupStarted: () => existsSync(marker),
        close: async () => {
            restore(pathKey, previous.path);
            restore(`INTENTIC_APP_URL`, previous.appUrl);
            restore(`INTENTIC_PLATFORM_URL`, previous.platformUrl);
            restore(`IC_BIN`, previous.icBin);
            restore(`INTENTIC_DISABLE_UPDATE_CHECK`, previous.disableUpdateCheck);
            await restoreState();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            });
            await rm(directory, { recursive: true, force: true });
        },
    };
};
