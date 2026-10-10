import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import { activeEngine, endpointOf, engineEnvChanges, pipePath } from "./engine-env.js";

const delimiter = win32.delimiter;

const record = { host: "tcp://127.0.0.1:2378", certPath: "C:\\Users\\me\\.intentic\\engine\\tls", bin: "C:\\Users\\me\\.intentic\\engine\\bin" };

describe("the engine this agent's docker reaches", () => {
    test("an active record, or one from before the switch existed, is our engine", () => {
        const written = JSON.stringify({ engine: "intentic", ...record, version: "1.0.0" });
        expect(activeEngine(written)).toEqual(record);
        expect(activeEngine(JSON.stringify({ engine: "intentic", ...record, active: true }))).toEqual(record);
    });

    test("an engine installed beside Docker Desktop and not switched on is not", () => {
        expect(activeEngine(JSON.stringify({ engine: "intentic", ...record, active: false }))).toBeUndefined();
        expect(activeEngine("not json")).toBeUndefined();
        expect(activeEngine(undefined)).toBeUndefined();
        expect(activeEngine(JSON.stringify({ engine: "dockerDesktop", ...record }))).toBeUndefined();
    });

    test("our engine puts its CLI first on PATH once, and its TLS endpoint in the variables", () => {
        const changes = engineEnvChanges({ PATH: `C:\\Windows${delimiter}C:\\Tools` }, record, undefined);
        expect(changes["DOCKER_HOST"]).toBe(record.host);
        expect(changes["DOCKER_TLS_VERIFY"]).toBe("1");
        expect(changes["DOCKER_CERT_PATH"]).toBe(record.certPath);
        expect(changes["PATH"]?.split(delimiter)[0]).toBe(record.bin);
        const again = engineEnvChanges({ PATH: `${record.bin}${delimiter}C:\\Windows` }, record, record.host);
        expect(again["PATH"]).toBeUndefined();
    });

    test("the relay's pipe is read from the record, and used only while it is there", () => {
        const pipe = "npipe:////./pipe/intentic-engine.me";
        const piped = activeEngine(JSON.stringify({ engine: "intentic", ...record, pipe }));
        expect(piped).toEqual({ ...record, pipe });
        expect(pipePath(pipe)).toBe("\\\\.\\pipe\\intentic-engine.me");
        expect(pipePath(record.host)).toBeUndefined();
        expect(endpointOf(piped!, () => true)).toEqual({ host: pipe, tls: false });
        expect(endpointOf(piped!, () => false)).toEqual({ host: record.host, tls: true });
        const over = engineEnvChanges({ PATH: record.bin, DOCKER_TLS_VERIFY: "1" }, piped, record.host, () => true);
        expect(over).toEqual({ DOCKER_HOST: pipe, DOCKER_TLS_VERIFY: undefined, DOCKER_CERT_PATH: undefined });
        // The relay gone: back to TLS, by itself, on the next round.
        expect(engineEnvChanges({ PATH: record.bin }, piped, pipe, () => false)["DOCKER_HOST"]).toBe(record.host);
    });

    test("after a move back, only the host this agent set is taken back", () => {
        expect(engineEnvChanges({ DOCKER_HOST: record.host }, undefined, record.host)).toEqual({
            DOCKER_HOST: undefined,
            DOCKER_TLS_VERIFY: undefined,
            DOCKER_CERT_PATH: undefined,
        });
        expect(engineEnvChanges({ DOCKER_HOST: "tcp://10.0.0.5:2376" }, undefined, record.host)).toEqual({});
        expect(engineEnvChanges({}, undefined, undefined)).toEqual({});
    });
});
