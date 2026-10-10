import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import { activeEngine, engineEnvChanges } from "./engine-env.js";

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
