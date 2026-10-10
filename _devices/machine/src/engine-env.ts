import { existsSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { homeDir } from "@intentic/local-agent";

// The agent acts on this only on Windows, and the tests run on Linux: the separator is spelled as Windows spells it.
const delimiter = win32.delimiter;

// INTENTIC'S ENGINE, FOR EVERY `docker` THIS AGENT SPAWNS (2026-10-09). On a Windows PC whose sandboxes run on our
// engine, `docker` must be the engine's own CLI pointed at its TLS endpoint, which `ic` writes to
// `~/.intentic/engine/engine.json` (_sandbox/ic/src/engine/record.rs). Every spawn here inherits this process's
// environment, so the agent keeps that environment in step with the record once per round: a move between engines
// (`ic engine move`) switches the record while the agent runs, and a stale DOCKER_HOST would send its port mirror, its
// sync and its keeper to an engine no sandbox runs on any more.
//
// THE PIPE (2026-10-10). Since ic's relay (_sandbox/ic/src/engine/relay.rs) serves the engine on a named pipe, the
// record names that too (`pipe`), and `docker` goes through it while it is there: docker.exe reads the TLS endpoint at
// 31–40 MB/s on omen and the pipe at 140–160 (_sandbox/ic/docker-host/src/engine_pipe.rs), which is the speed of this
// agent's sync (`docker exec -i`). Over the pipe there is no TLS: the relay holds the certificate.

const VARS = ["DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"] as const;

export interface EngineRecord {
    readonly host: string;
    readonly certPath: string;
    readonly bin: string;
    /** `npipe:////./pipe/<distro>.<user>`, once a start has run the relay. */
    readonly pipe?: string;
}

// The record when this account's sandboxes run on our engine: written by ic, `engine: intentic`, and not switched off
// (`active: false` is an engine installed beside Docker Desktop, ready for a move; a record from before the switch
// existed is an active one).
export const activeEngine = (text: string | undefined): EngineRecord | undefined => {
    if (text === undefined) {
        return undefined;
    }
    let record: unknown;
    try {
        record = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof record !== "object" || record === null) {
        return undefined;
    }
    const fields = record as Record<string, unknown>;
    if (fields["engine"] !== "intentic" || fields["active"] === false) {
        return undefined;
    }
    const { host, certPath, bin, pipe } = fields;
    if (typeof host !== "string" || typeof certPath !== "string" || typeof bin !== "string") {
        return undefined;
    }
    return typeof pipe === "string" ? { host, certPath, bin, pipe } : { host, certPath, bin };
};

// `\\.\pipe\x` for `npipe:////./pipe/x`, the path a presence check looks at. Pure.
export const pipePath = (host: string): string | undefined => {
    const leaf = host.startsWith("npipe:////./pipe/") ? host.slice("npipe:////./pipe/".length) : "";
    return leaf !== "" && !/[\\/]/.test(leaf) ? `\\\\.\\pipe\\${leaf}` : undefined;
};

// The way `docker` reaches `record`: its pipe while the relay serves it (`present`), its TLS endpoint otherwise. Pure.
export const endpointOf = (record: EngineRecord, present: (path: string) => boolean): { readonly host: string; readonly tls: boolean } => {
    const path = record.pipe === undefined ? undefined : pipePath(record.pipe);
    return record.pipe !== undefined && path !== undefined && present(path) ? { host: record.pipe, tls: false } : { host: record.host, tls: true };
};

// What to set (a string) and unset (undefined) in an environment so `docker` reaches `record`, or, without one, the
// engine `docker` finds by itself. `ours` is the host this agent last pointed `docker` at, the only DOCKER_HOST it
// takes back: one a person set for their own reasons is theirs. Pure.
export const engineEnvChanges = (
    env: Readonly<Record<string, string | undefined>>,
    record: EngineRecord | undefined,
    ours: string | undefined,
    present: (path: string) => boolean = () => false,
): Record<string, string | undefined> => {
    if (record === undefined) {
        if (ours === undefined || env["DOCKER_HOST"] !== ours) {
            return {};
        }
        return Object.fromEntries(VARS.map((name) => [name, undefined]));
    }
    const path = env["PATH"] ?? env["Path"] ?? "";
    const first = path.split(delimiter)[0];
    const endpoint = endpointOf(record, present);
    return {
        DOCKER_HOST: endpoint.host,
        DOCKER_TLS_VERIFY: endpoint.tls ? "1" : undefined,
        DOCKER_CERT_PATH: endpoint.tls ? record.certPath : undefined,
        ...(first === record.bin ? {} : { PATH: [record.bin, path].filter((part) => part !== "").join(delimiter) }),
    };
};

let pointedAt: string | undefined;

// Read the record and bring this process's environment in step with it. Windows only: elsewhere `docker` is the
// system's own, and inside WSL the sandboxes stay on Docker Desktop through its integration.
export const syncEngineEnv = (env: NodeJS.ProcessEnv = process.env, home: string = homeDir()): void => {
    if (process.platform !== "win32") {
        return;
    }
    let text: string | undefined;
    try {
        text = readFileSync(join(home, ".intentic", "engine", "engine.json"), "utf8");
    } catch {
        text = undefined;
    }
    const record = activeEngine(text);
    const changes = engineEnvChanges(env, record, pointedAt, existsSync);
    for (const [name, value] of Object.entries(changes)) {
        if (value === undefined) {
            delete env[name];
        } else {
            env[name] = value;
        }
    }
    pointedAt = record === undefined ? undefined : changes["DOCKER_HOST"];
};
