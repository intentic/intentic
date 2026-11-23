import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PORT, PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { localDaemonPort } from "@intentic/sandbox-run";
import { requires } from "@intentic/testing/requires";
import { composeBootstrap, composeFile } from "../setupCompose";

/* The Compose tab's bootstrap, run as the reader runs it: through a shell and curl, in the folder holding their own
 * project's docker-compose.yml and `.env`, against a loopback claim endpoint answering the way the platform's does
 * (KEY=value lines, 404 for a refused code). It used to be `curl … > .env`, which truncated the owner's `.env` before
 * curl ran and left it empty when the claim was refused (docs/onboarding-hunt-2026-10-23). */

const SANDBOX_ID = `0f00ba4dd12b`;
const GOOD = `GOOD-CODE`;
const CLAIM = [`CONNECT_TOKEN=ict_claimed`, `LOCAL_PORT=${localDaemonPort(SANDBOX_ID)}`, `SANDBOX_GRANT=grant.claimed`, `INGRESS_URL=https://edge.example`, `OWNER_EMAIL=owner@example.com`].join(`\n`);
// The owner's own settings, with bytes a careless rewrite would change: no trailing newline, a `$`, a CRLF.
const OWNER_ENV = `DB_PASSWORD=hunter2\r\nAPP_URL=http://app.local/$path\nCOMPOSE_PROJECT_NAME=shop`;
const OWNER_SERVICE = `services:\n    db:\n        image: postgres\n        environment:\n            POSTGRES_PASSWORD: \${DB_PASSWORD:?missing}\n`;

let server: Server;
let platformUrl: string;
const folders: string[] = [];

beforeAll(async () => {
    server = createServer((request, response) => {
        let body = ``;
        request.on(`data`, (chunk: Buffer) => {
            body += chunk.toString();
        });
        request.on(`end`, () => {
            const code = new URLSearchParams(body).get(`code`);
            if (request.url === `/setup/claim` && code === GOOD) {
                response.end(CLAIM);
                return;
            }
            response.writeHead(404).end(`setup code invalid or expired`);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, `127.0.0.1`, resolve));
    // SAFETY: a server listening on a TCP port answers address() with an AddressInfo, never a pipe's string.
    platformUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
    server.close();
    for (const folder of folders) {
        rmSync(folder, { recursive: true, force: true });
    }
});

const args = (code: string) => ({
    code,
    hostname: `sandbox-${SANDBOX_ID}.intentic.dev`,
    image: `ghcr.io/intentic/sandbox:stable`,
    googleClientId: `client-id.apps.googleusercontent.com`,
    webOrigin: PLATFORM_WEB_ORIGIN,
    platformUrl,
});

// A project folder as the tab finds it: the owner's own `.env`, and their compose file with the sandbox's service added.
const projectFolder = (): string => {
    const folder = mkdtempSync(join(tmpdir(), `intentic-compose-claim-`));
    folders.push(folder);
    writeFileSync(join(folder, `.env`), OWNER_ENV);
    const sandbox = composeFile(args(GOOD)).replace(/^services:\n/mu, ``);
    writeFileSync(join(folder, `docker-compose.yml`), `${OWNER_SERVICE}${sandbox}`);
    return folder;
};

// The claim line alone: the second line starts the sandbox, which this test does not. Asynchronous, since the claim
// endpoint answers from this same process. Its exit status: 0 for a claim that went through.
const runClaim = (folder: string, code: string): Promise<number> => {
    const claim = composeBootstrap(args(code)).split(`\n`)[0] ?? ``;
    return new Promise((resolve) => {
        execFile(`sh`, [`-c`, claim], { cwd: folder }, (error) => resolve(error === null ? 0 : Number(error.code ?? 1)));
    });
};

test(`a successful claim writes intentic.env, owner-only, and leaves the owner's .env byte for byte`, async () => {
    const folder = projectFolder();
    expect(await runClaim(folder, GOOD)).toBe(0);
    expect(readFileSync(join(folder, `.env`), `utf8`)).toBe(OWNER_ENV);
    expect(readFileSync(join(folder, `intentic.env`), `utf8`)).toBe(CLAIM);
    expect(statSync(join(folder, `intentic.env`)).mode & 0o777).toBe(0o600);
});

test(`a refused claim fails, leaves the owner's .env byte for byte, and writes no credentials file`, async () => {
    const folder = projectFolder();
    // curl -f's own exit for an HTTP error.
    expect(await runClaim(folder, `EXPIRED-CODE`)).toBe(22);
    expect(readFileSync(join(folder, `.env`), `utf8`)).toBe(OWNER_ENV);
    expect(() => statSync(join(folder, `intentic.env`))).toThrow(/ENOENT/u);
});

test(`a refused re-run keeps the credentials file the last good claim wrote`, async () => {
    const folder = projectFolder();
    expect(await runClaim(folder, GOOD)).toBe(0);
    expect(await runClaim(folder, `EXPIRED-CODE`)).toBe(22);
    expect(readFileSync(join(folder, `intentic.env`), `utf8`)).toBe(CLAIM);
});

const compose = requires(spawnSync(`docker`, [`compose`, `version`]).status === 0, `the docker compose CLI`, {
    absentOnCi: `the editor's test job carries no Docker CLI; the onboarding tier's compose provisioner runs the file for real`,
});

test.skipIf(!compose.runs)(compose.title(`compose reads the claimed values into the sandbox and the owner's .env into their own service`), async () => {
    const folder = projectFolder();
    expect(await runClaim(folder, GOOD)).toBe(0);
    // SAFETY: `docker compose config --format json` prints the resolved project, whose services carry these keys.
    const config = JSON.parse(execFileSync(`docker`, [`compose`, `config`, `--format`, `json`], { cwd: folder, encoding: `utf8` })) as {
        services: Record<string, { environment: Record<string, string>; ports?: { published: string; target: number }[] }>;
    };
    const sandbox = config.services[`intentic-sandbox`];
    expect(sandbox?.environment).toMatchObject({
        CONNECT_TOKEN: `ict_claimed`,
        SANDBOX_GRANT: `grant.claimed`,
        INGRESS_URL: `https://edge.example`,
        OWNER_EMAIL: `owner@example.com`,
        // The claim's LOCAL_PORT is the host's; inside, the listener keeps its own port.
        LOCAL_PORT: String(LOCAL_PORT),
        SANDBOX_COMPOSE_CREDENTIALS: `intentic.env`,
    });
    expect(sandbox?.ports).toEqual([expect.objectContaining({ published: String(localDaemonPort(SANDBOX_ID)), target: LOCAL_PORT })]);
    expect(config.services[`db`]?.environment[`POSTGRES_PASSWORD`]).toBe(`hunter2`);
    expect(readFileSync(join(folder, `.env`), `utf8`)).toBe(OWNER_ENV);
});
