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

/* The cold OS launch inherits this process's environment through PowerShell's Start-Process. That gives tier 1
 * a real link and real installed app without giving the setup it starts access to a real platform, Docker, or
 * CLI. The fake executables are deliberately failing after they prove the handoff happened: this tier owns the
 * window and packaging path; the nightly owns a successful sandbox setup with the real programs. */
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

    // Settings intentionally precede environment defaults in the app. Writing the real Tauri config location
    // makes the cold launch hermetic even when this runner preserved a developer setting across an uninstall.
    const appData = process.env[`APPDATA`];
    if (appData === undefined || appData === ``) {
        throw new Error(`APPDATA is unavailable; the installed app's settings location cannot be prepared`);
    }
    const settingsPath = join(appData, APP_IDENTIFIER, `settings.json`);
    const previousSettings = existsSync(settingsPath) ? await readFile(settingsPath) : undefined;
    await mkdir(join(appData, APP_IDENTIFIER), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ appUrl: workspaceUrl, platformUrl: origin }, undefined, 2));

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
            if (previousSettings === undefined) {
                await rm(settingsPath, { force: true });
            } else {
                await writeFile(settingsPath, previousSettings);
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            });
            await rm(directory, { recursive: true, force: true });
        },
    };
};
