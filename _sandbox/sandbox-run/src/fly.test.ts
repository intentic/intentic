import { PREVIEW_PORT } from "@intentic/constants";
import { describe, expect, it } from "vitest";
import { FLY_VOLUME_LAYOUT, FLY_VOLUME_PATH, FRONT_DOOR_CONCURRENCY, flyBuildMachineConfig, flyMachineConfig } from "./fly.js";

describe(`flyMachineConfig`, () => {
    const run = {
        name: `intentic-sbx-abc123`,
        image: `ghcr.io/intentic/sandbox:stable`,
        baseImage: `ghcr.io/intentic/sandbox:stable`,
        guest: { cpus: 4, memoryMb: 8192 },
        volumeId: `vol_123`,
    };

    it(`emits the machine shape: image, shared guest, single volume at the layout path, bounded on-failure restart`, () => {
        const config = flyMachineConfig(run);
        expect(config.image).toBe(run.image);
        expect(config.guest).toEqual({ cpu_kind: `shared`, cpus: 4, memory_mb: 8192 });
        expect(config.mounts).toEqual([{ volume: `vol_123`, path: FLY_VOLUME_PATH }]);
        expect(config.restart).toEqual({ policy: `on-failure`, max_retries: 3 });
        expect(config.auto_destroy).toBe(false);
    });

    it(`stamps the contract env (name, image pair, the VM switch) before the caller's pairs`, () => {
        const config = flyMachineConfig({ ...run, env: [[`CONNECT_TOKEN`, `t0k`]] });
        expect(Object.entries(config.env)).toEqual([
            [`SANDBOX_NAME`, `intentic-sbx-abc123`],
            [`SANDBOX_IMAGE`, `ghcr.io/intentic/sandbox:stable`],
            [`SANDBOX_BASE_IMAGE`, `ghcr.io/intentic/sandbox:stable`],
            [`SANDBOX_VM`, `1`],
            [`CONNECT_TOKEN`, `t0k`],
        ]);
    });

    it(`drops empty env values, an empty secret must not shadow the workspace .env`, () => {
        const config = flyMachineConfig({
            ...run,
            env: [
                [`OWNER_EMAIL`, `o@example.com`],
                [`HOST_SSH_KEY`, ``],
            ],
        });
        expect(config.env[`OWNER_EMAIL`]).toBe(`o@example.com`);
        expect(`HOST_SSH_KEY` in config.env).toBe(false);
    });

    it(`keeps the volume layout under the mount path, the entrypoint's VM mode links onto these`, () => {
        expect(FLY_VOLUME_LAYOUT.workspace.startsWith(`${FLY_VOLUME_PATH}/`)).toBe(true);
        expect(FLY_VOLUME_LAYOUT.history.startsWith(`${FLY_VOLUME_PATH}/`)).toBe(true);
        expect(FLY_VOLUME_LAYOUT.docker.startsWith(`${FLY_VOLUME_PATH}/`)).toBe(true);
    });
});

describe(`flyMachineConfig: the front door`, () => {
    const run = {
        name: `intentic-sbx-abcdef012345`,
        image: `ghcr.io/intentic/sandbox:stable`,
        baseImage: `ghcr.io/intentic/sandbox:stable`,
        guest: { cpus: 2, memoryMb: 4096 },
        volumeId: `vol_123`,
    };

    /* A hosted machine is reached by a Fly replay from the edge, so the machine itself declares the service the
     * proxy delivers to: the preview proxy, which already routes every hostname the sandbox answers to. */
    it(`declares the preview proxy as the one public service when the run names a hostname`, () => {
        const config = flyMachineConfig({ ...run, frontDoor: { hostname: `sandbox-abcdef012345.sbx.test` } });
        expect(config.services).toHaveLength(1);
        const service = config.services![0]!;
        expect(service.internal_port).toBe(PREVIEW_PORT);
        expect(service.ports.map((port) => port.port)).toEqual([443, 80]);
        expect(service.ports[0]!.handlers).toEqual([`tls`, `http`]);
        // h2 to the browser: an app holding a stream per window cannot live inside HTTP/1.1's six per origin.
        expect(service.ports[0]!.tls_options?.alpn).toEqual([`h2`, `http/1.1`]);
        expect(service.ports[1]!.force_https).toBe(true);
    });

    // Long-lived streams are the workload, so the proxy must count connections, not in-flight requests.
    it(`counts connections, not requests, so held streams cannot walk a healthy machine to its hard limit`, () => {
        const config = flyMachineConfig({ ...run, frontDoor: { hostname: `sandbox-abcdef012345.sbx.test` } });
        expect(config.services![0]!.concurrency).toEqual(FRONT_DOOR_CONCURRENCY);
        expect(FRONT_DOOR_CONCURRENCY.type).toBe(`connections`);
    });

    // Power stays the platform's (the hour meter is checked at wake) and the daemon's (idle-stop is its
    // clean exit); the proxy neither starts nor stops anything.
    it(`leaves starting and stopping to the platform and the daemon`, () => {
        const service = flyMachineConfig({ ...run, frontDoor: { hostname: `sandbox-abcdef012345.sbx.test` } }).services![0]!;
        expect(service.autostart).toBe(false);
        expect(service.autostop).toBe(`off`);
    });

    it(`checks the daemon's /health through the front door under the sandbox's own hostname`, () => {
        const config = flyMachineConfig({ ...run, frontDoor: { hostname: `sandbox-abcdef012345.sbx.test` } });
        const check = config.checks?.[`front-door`];
        expect(check?.port).toBe(PREVIEW_PORT);
        expect(check?.path).toBe(`/health`);
        // Any other Host is a 404 from the preview proxy, by design: the header is what makes the check true.
        expect(check?.headers).toEqual([{ name: `Host`, values: [`sandbox-abcdef012345.sbx.test`] }]);
    });

    // A warm pool machine runs nothing on its one boot, so a service on it would only ever fail its check.
    it(`declares no service and no check for a run without a hostname`, () => {
        const config = flyMachineConfig(run);
        expect(config.services).toBeUndefined();
        expect(config.checks).toBeUndefined();
    });
});

describe(`flyMachineConfig: an overlay-built image`, () => {
    const run = {
        name: `intentic-sbx-abcdef012345`,
        image: `registry.fly.io/intentic-sbx-abcdef012345:env-0123456789ab`,
        baseImage: `ghcr.io/intentic/sandbox:stable`,
        guest: { cpus: 4, memoryMb: 4096 },
        volumeId: `vol_123`,
    };

    // The daemon derives "applied" from this hash against the approved file's, exactly as it does on a
    // docker host recreated by ic; the base stays the official tag so a recompose keeps extending it.
    it(`stamps the approved overlay's hash beside the image pair`, () => {
        const hash = `a`.repeat(64);
        const config = flyMachineConfig({ ...run, environmentHash: hash });
        expect(Object.entries(config.env).slice(0, 4)).toEqual([
            [`SANDBOX_NAME`, run.name],
            [`SANDBOX_IMAGE`, run.image],
            [`SANDBOX_BASE_IMAGE`, `ghcr.io/intentic/sandbox:stable`],
            [`SANDBOX_ENVIRONMENT_HASH`, hash],
        ]);
    });

    it(`stamps no hash for a stock image`, () => {
        expect(`SANDBOX_ENVIRONMENT_HASH` in flyMachineConfig(run).env).toBe(false);
    });
});

describe(`flyBuildMachineConfig`, () => {
    const build = {
        image: `moby/buildkit:v0.20.2`,
        guest: { cpuKind: `shared` as const, cpus: 2, memoryMb: 4096 },
        files: [
            { path: `/build/Dockerfile`, content: `FROM ghcr.io/intentic/sandbox:stable\nRUN true\n` },
            { path: `/build/run.sh`, content: `#!/bin/sh\nexit 0\n` },
        ],
        entrypoint: [`/bin/sh`, `/build/run.sh`],
    };

    it(`is a guest of the platform's chosen CPU kind with no volume, no restart and the script as its entrypoint`, () => {
        const config = flyBuildMachineConfig(build);
        expect(config.image).toBe(build.image);
        expect(config.guest).toEqual({ cpu_kind: `shared`, cpus: 2, memory_mb: 4096 });
        expect(flyBuildMachineConfig({ ...build, guest: { ...build.guest, cpuKind: `performance` } }).guest.cpu_kind).toBe(`performance`);
        expect(config.mounts).toEqual([]);
        expect(config.restart).toEqual({ policy: `no` });
        expect(config.auto_destroy).toBe(false);
        expect(config.init).toEqual({ entrypoint: [`/bin/sh`, `/build/run.sh`] });
        expect(config.services).toBeUndefined();
        expect(config.checks).toBeUndefined();
    });

    it(`delivers every file base64-encoded at its guest path`, () => {
        const files = flyBuildMachineConfig(build).files!;
        expect(files.map((file) => file.guest_path)).toEqual([`/build/Dockerfile`, `/build/run.sh`]);
        expect(files.map((file) => Buffer.from(file.raw_value, `base64`).toString(`utf8`))).toEqual(build.files.map((file) => file.content));
    });

    it(`carries only the env pairs with a value`, () => {
        const config = flyBuildMachineConfig({
            ...build,
            env: [
                [`PLATFORM_URL`, `https://api.test`],
                [`EMPTY`, ``],
            ],
        });
        expect(config.env).toEqual({ PLATFORM_URL: `https://api.test` });
    });
});
