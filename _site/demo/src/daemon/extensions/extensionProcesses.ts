import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { demoExtensions } from "./extensionList";
import { pushRuntimeChanged } from "../broadcast";
import { okAfter } from "../doors";
import { registerTerminalSource } from "../machine/terminals";

// The background processes extensions declare (`contributes.processes`), supervised the way the daemon's service
// supervisor keeps them: started on a press, given a port, stopped on another. Each move is pushed as the daemon pushes
// its own, so the terminals list and every panel reading the process re-read it.

type Status = SandboxHandlerOutput<`extensions`, `processStatus`>;

interface Supervised {
    running: boolean;
    readonly port: number;
    // When it last started, which its terminal row reads as its last activity.
    since: number;
}

// Ports the supervisor hands out, from the range the daemon gives extension processes.
const FIRST_PORT = 4310;
const supervised = new Map<string, Supervised>();
const keyOf = (id: string, name: string): string => `${id}/${name}`;

const declared = (id: string, name: string): ExtensionSummary => {
    const extension = demoExtensions().find((candidate) => candidate.id === id) ?? refuse(`no extension with that id is installed`, 404);
    return (extension.manifest.contributes?.processes ?? []).some((process) => process.name === name)
        ? extension
        : refuse(`the extension declares no process "${name}"`, 404);
};

export const processStatus = (id: string, name: string): Status => {
    declared(id, name);
    const process = supervised.get(keyOf(id, name));
    if (process === undefined) {
        return { name, running: false };
    }
    return { name, running: process.running, port: process.port, restarts: 0 };
};

export const startProcess = (id: string, name: string) => {
    const extension = declared(id, name);
    if (!extension.enabled) {
        refuse(`the extension is disabled`, 412);
    }
    return okAfter(() => {
        const key = keyOf(id, name);
        const port = supervised.get(key)?.port ?? FIRST_PORT + supervised.size;
        supervised.set(key, { running: true, port, since: Date.now() });
        pushRuntimeChanged(`terminals`, `panels`);
    });
};

// Idempotent like the daemon's: stopping what is not running is not an error, and the port stays reserved for it.
export const stopProcess = (id: string, name: string) => {
    declared(id, name);
    return okAfter(() => {
        const process = supervised.get(keyOf(id, name));
        if (process?.running === true) {
            process.running = false;
            pushRuntimeChanged(`terminals`, `panels`);
        }
    });
};

/** The names of an extension's processes that are up, which a removal stops first. */
export const runningProcesses = (id: string): string[] =>
    [...supervised.entries()].filter(([key, process]) => process.running && key.startsWith(`${id}/`)).map(([key]) => key.slice(id.length + 1));

/** Stops and forgets every process of one extension: it is being removed or switched off. */
export const stopAllOf = (id: string): void => {
    for (const key of [...supervised.keys()].filter((candidate) => candidate.startsWith(`${id}/`))) {
        supervised.delete(key);
    }
    pushRuntimeChanged(`terminals`, `panels`);
};

// The supervisor's own key for a process and the terminal session it is listed under (the daemon's extensionProcessKey
// and serviceSession): `svc-ext-<id, dots as dashes>-<name>`.
const SERVICE_PREFIX = `svc-`;
const sessionOf = (id: string, name: string): string => `${SERVICE_PREFIX}ext-${id.replaceAll(`.`, `-`)}-${name}`;

// Every process up is a row of the terminals list, kind `process`, named for the extension and process it is; closing
// its row stops it, as the daemon's killTerminal stops a supervised service.
registerTerminalSource(
    () =>
        [...supervised.entries()].flatMap(([key, process]) => {
            const [id = ``, ...rest] = key.split(`/`);
            const name = rest.join(`/`);
            const session = sessionOf(id, name);
            return process.running
                ? [{ name: session, label: session.slice(SERVICE_PREFIX.length), kind: `process` as const, running: true, activityAt: process.since, extensionId: id, processName: name }]
                : [];
        }),
    (session) => {
        const found = [...supervised.entries()].find(([key, process]) => {
            const [id = ``, ...rest] = key.split(`/`);
            return process.running && sessionOf(id, rest.join(`/`)) === session;
        });
        if (found === undefined) {
            return false;
        }
        found[1].running = false;
        pushRuntimeChanged(`terminals`, `panels`);
        return true;
    },
);
