#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createLocalOffice } from "@intentic/ext-onlyoffice/local-office";
import { controlLine, type ControlEvent, parseControlLine } from "./control.js";
import { grantFor, Grants } from "./grants.js";
import { createLocalFilesServer } from "./server.js";
import { Watches } from "./watch.js";

// intentic-files: started by the desktop app, one process for all its windows. It listens on a loopback port it picks,
// says which on stdout, and serves the folders the app grants on stdin until that stdin closes.
//
//   intentic-files serve --origin tauri://localhost --cache <dir> --office-page <dir>
//   intentic-files version

declare const INTENTIC_AGENT_VERSION: string | undefined;

// Stamped at compile time (build-agent-binaries.sh); the working tree's sentinel otherwise.
const VERSION: string = typeof INTENTIC_AGENT_VERSION === `string` ? INTENTIC_AGENT_VERSION : `0.0.0`;

const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
};

const say = (event: ControlEvent): void => {
    process.stdout.write(controlLine(event));
};

const serveFolders = async (argv: readonly string[]): Promise<void> => {
    const { values } = parseArgs({
        args: [...argv],
        options: {
            origin: { type: `string`, multiple: true, default: [] },
            cache: { type: `string` },
            "office-page": { type: `string` },
            port: { type: `string`, default: `0` },
        },
    });
    if (values.cache === undefined || values[`office-page`] === undefined) {
        log(`usage: intentic-files serve --origin <app origin>... --cache <dir> --office-page <dir> [--port <n>]`);
        process.exit(2);
    }
    const grants = new Grants();
    const office = createLocalOffice({ cacheDir: values.cache, pageDir: values[`office-page`], log });
    const server = createLocalFilesServer({
        grants,
        office,
        context: { watches: new Watches(log), build: `local-files-${VERSION}`, startedAt: Date.now() },
        origins: new Set(values.origin),
        log,
    });
    const listening = Bun.serve({
        hostname: `127.0.0.1`,
        port: Number(values.port),
        // An event stream sends a heartbeat every two seconds; the rest answer well inside this.
        idleTimeout: 30,
        fetch: (request, self) => server.fetch(request, self.port ?? 0),
    });
    say({ event: `ready`, port: listening.port ?? 0, version: VERSION });

    const lines = createInterface({ input: process.stdin });
    lines.on(`line`, (line) => {
        if (line.trim() === ``) {
            return;
        }
        const message = parseControlLine(line);
        if (`error` in message) {
            log(`ignored a control line: ${message.error}`);
            return;
        }
        if (message.op === `revoke`) {
            const revoked = grants.revoke(message.token);
            if (revoked !== undefined) {
                void server.forget(revoked);
            }
            say({ event: `revoked`, token: message.token });
            return;
        }
        void grantFor(message).then((grant) => {
            if (`error` in grant) {
                say({ event: `refused`, token: message.token, error: grant.error });
                return;
            }
            grants.add(grant);
            // A folder grant has no file, which the line then leaves out.
            say({ event: `granted`, token: grant.token, root: grant.root, name: grant.name, file: grant.file });
        });
    });
    // The app is gone, or let go of this process: nothing may keep serving its folders.
    lines.on(`close`, () => {
        void office.close().finally(() => {
            void listening.stop(true);
            process.exit(0);
        });
    });
};

const [command = `serve`, ...rest] = process.argv.slice(2);
if (command === `version`) {
    process.stdout.write(`${VERSION}\n`);
} else if (command === `serve`) {
    await serveFolders(rest);
} else {
    log(`unknown command ${command}: expected serve or version`);
    process.exit(2);
}
