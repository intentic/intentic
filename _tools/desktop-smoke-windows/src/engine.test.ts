import { describe, expect, test } from "bun:test";
import { ENGINE_DISTRO, engineDockerOf, engineStatusOf, isolatedEnv, moveLines } from "./engine.js";

describe(`the engine tier's readings`, () => {
    test(`the status is the last JSON line ic printed`, () => {
        const said = `Starting the intentic engine…\n{"engine":"dockerDesktop","installed":true,"running":true,"active":false,"held":false,"canMove":true}\n`;
        expect(engineStatusOf(said)).toEqual({ engine: `dockerDesktop`, installed: true, running: true, active: false, held: false });
        const piped = `{"engine":"intentic","installed":true,"running":true,"active":true,"held":false,"network":"isolated","pipe":"npipe:////./pipe/intentic-engine-ci.runner"}`;
        expect(engineStatusOf(piped)).toEqual({
            engine: `intentic`,
            installed: true,
            running: true,
            active: true,
            held: false,
            network: `isolated`,
            pipe: `npipe:////./pipe/intentic-engine-ci.runner`,
        });
        expect(engineStatusOf(`no json here`)).toBeUndefined();
        expect(engineStatusOf(`{"installed":true}`)).toBeUndefined();
    });

    test(`only intentic-move lines are read, each as the JSON it carries`, () => {
        const said = [
            `intentic-move: {"slug":"winengine","step":"begin","count":1}`,
            `intentic: recreating the sandbox…`,
            `intentic-move: not json`,
            `intentic-move: {"slug":"","step":"done","engine":"intentic","count":1}`,
        ].join(`\r\n`);
        expect(moveLines(said).map((line) => line[`step`])).toEqual([`begin`, `done`]);
    });

    test(`ic runs with a home, a disk and a distro of the tier's own, and no sign-in start`, () => {
        const env = isolatedEnv(`C:\\t`, `C:\\a\\engine.tar.gz`);
        expect(env[`USERPROFILE`]).toBe(`C:\\t\\home`);
        expect(env[`INTENTIC_HOME`]).toBe(`C:\\t\\home\\.intentic`);
        expect(env[`LOCALAPPDATA`]).toBe(`C:\\t\\localappdata`);
        expect(env[`IC_ENGINE_DISTRO`]).toBe(ENGINE_DISTRO);
        expect(env[`IC_ENGINE_AUTOSTART`]).toBe(`0`);
        expect(env[`INTENTIC_ENGINE_TARBALL`]).toBe(`C:\\a\\engine.tar.gz`);
    });

    test(`the tier's docker reaches the engine through the record's CLI and TLS`, () => {
        const record = JSON.stringify({ engine: `intentic`, host: `tcp://127.0.0.1:2378`, certPath: `C:\\h\\tls`, bin: `C:\\h\\bin`, version: `1.0.0` });
        expect(engineDockerOf(record)).toEqual({
            docker: `C:\\h\\bin\\docker.exe`,
            env: { DOCKER_HOST: `tcp://127.0.0.1:2378`, DOCKER_TLS_VERIFY: `1`, DOCKER_CERT_PATH: `C:\\h\\tls` },
        });
        expect(engineDockerOf(`{}`)).toBeUndefined();
        expect(engineDockerOf(`nope`)).toBeUndefined();
    });
});
