#!/usr/bin/env bun
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { within } from "@intentic/base/async";
import { STATE_DIR } from "@intentic/constants";
import { createLocalOffice } from "@intentic/ext-onlyoffice/local-office";
import { createHostAgents } from "@intentic/host-agents";
import { Asks } from "./asks.js";
import { controlChannel } from "./channel.js";
import { controlLine, type ControlEvent } from "./control.js";
import { DerivedTexts } from "./derived.js";
import { Grants } from "./grants.js";
import { ripgrepWith, searchToolsIn } from "./ripgrep.js";
import { createLocalFilesServer, unhurried } from "./server.js";
import { Watches } from "./watch.js";

// intentic-files: started by the desktop app, one process for all its windows. It listens on a loopback port it picks,
// says which on stdout, and serves the folders the app grants on stdin until that stdin closes.
//
//   intentic-files serve --origin tauri://localhost --cache <dir> --office-page <dir> [--derived-cache <dir>]
//                        [--search-tools <dir>] [--agents-home <dir>] [--agents-accepted] [--no-agents]
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

// The agents that run on this computer itself, served to the windows beside their folders: where their conversations
// are kept, whether the reader has turned them on (the app says so, at the start and whenever it changes), and how
// many turns run, said to the app each time that changes.
const agentsOfThisComputer = (home: string | undefined, accepted: boolean) => {
    const reader = { accepted };
    const agents = createHostAgents({
        home: home ?? join(homedir(), STATE_DIR, `host-agents`),
        log: (line) => log(`[agents] ${line}`),
        accepted: () => reader.accepted,
    });
    agents.onRunningChanged((running) => say({ event: `agents`, running }));
    return {
        agents,
        accept: (on: boolean): void => {
            reader.accepted = on;
        },
    };
};

const serveFolders = async (argv: readonly string[]): Promise<void> => {
    const { values } = parseArgs({
        args: [...argv],
        options: {
            origin: { type: `string`, multiple: true, default: [] },
            cache: { type: `string` },
            "office-page": { type: `string` },
            "derived-cache": { type: `string` },
            // The ripgrep the app ships (ripgrep.ts); without it the one on PATH, and without that the folder is read here.
            "search-tools": { type: `string` },
            port: { type: `string`, default: `0` },
            // Where this computer's conversations are kept; under the reader's home unless the app names a place.
            "agents-home": { type: `string` },
            // The reader already turned agents on (the app keeps their answer and says it again on the control channel).
            "agents-accepted": { type: `boolean`, default: false },
            // Serve folders only: no agents on this computer at all.
            "no-agents": { type: `boolean`, default: false },
        },
    });
    if (values.cache === undefined || values[`office-page`] === undefined) {
        log(
            `usage: intentic-files serve --origin <app origin>... --cache <dir> --office-page <dir> [--derived-cache <dir>] [--search-tools <dir>] [--port <n>]`,
        );
        process.exit(2);
    }
    const grants = new Grants();
    const asks = new Asks(say);
    const office = createLocalOffice({ cacheDir: values.cache, pageDir: values[`office-page`], log });
    // Beside the office cache the app names (`<app cache>/office`), unless it names one of its own.
    const derived = new DerivedTexts({ dir: values[`derived-cache`] ?? join(dirname(values.cache), `derived`), log });
    const tools = searchToolsIn(values[`search-tools`]);
    log(`search: ${tools.native ?? `no ripgrep here`}${tools.linux === undefined ? `` : `, ${tools.linux} for WSL folders`}`);
    const rg = tools.native === undefined && tools.linux === undefined ? undefined : ripgrepWith(tools);
    const hosted = values[`no-agents`] ? undefined : agentsOfThisComputer(values[`agents-home`], values[`agents-accepted`]);
    const agents = hosted?.agents;
    const server = createLocalFilesServer({
        grants,
        office,
        context: {
            watches: new Watches(log),
            build: `local-files-${VERSION}`,
            startedAt: Date.now(),
            ask: (verb, path) => asks.ask(verb, path),
            derived,
            rg,
            agents,
        },
        origins: new Set(values.origin),
        log,
    });
    const listening = Bun.serve({
        hostname: `127.0.0.1`,
        port: Number(values.port),
        // An event stream sends a heartbeat every two seconds, and most routes answer well inside this; the few that wait
        // on longer work have no idle bound at all.
        idleTimeout: 30,
        fetch: (request, self) => {
            if (unhurried(request)) {
                self.timeout(request, 0);
            }
            return server.fetch(request, self.port ?? 0);
        },
    });
    say({ event: `ready`, port: listening.port ?? 0, version: VERSION });

    const lines = createInterface({ input: process.stdin });
    lines.on(
        `line`,
        controlChannel({
            grants,
            server,
            office,
            asks,
            agentsAccepted: hosted?.accept,
            say,
            log,
        }),
    );
    // The app is gone, or let go of this process: nothing may keep serving its folders, and nothing it was asked can be
    // answered any more. The office editor is let go of first, for at most OFFICE_CLOSE_MS: its listener's close waits
    // for every open connection, and an editor page left open in a window that is going too held this process, and its
    // binary, past the app's own exit, so an installer could not replace it (2026-10-05).
    lines.on(`close`, () => {
        asks.close();
        // Every turn and every harness process ends with this one: nothing of an agent outlives the app.
        agents?.close();
        // A close that fails or hangs never keeps the process alive. The timer stays ref'd: it is the ceiling on this exit.
        // allow(silent-catch): this process is exiting either way, and a close that failed has nothing left to report to.
        void within(office.close().catch(() => undefined), OFFICE_CLOSE_MS, undefined).finally(() => {
            void listening.stop(true);
            process.exit(0);
        });
    });
};

/** How long the office editor gets to close before this process exits anyway. */
const OFFICE_CLOSE_MS = 3_000;

const [command = `serve`, ...rest] = process.argv.slice(2);
if (command === `version`) {
    process.stdout.write(`${VERSION}\n`);
} else if (command === `serve`) {
    await serveFolders(rest);
} else {
    log(`unknown command ${command}: expected serve or version`);
    process.exit(2);
}
