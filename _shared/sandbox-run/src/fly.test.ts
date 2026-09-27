import { FLY_VOLUME_LAYOUT, FLY_VOLUME_PATH, flyBuildMachineConfig, flyMachineConfig } from "./fly.js";

describe(`flyMachineConfig`, () => {
    const run = {
        name: `intentic-sbx-abc123`,
        image: `ghcr.io/intentic/sandbox:stable`,
        baseImage: `ghcr.io/intentic/sandbox:stable`,
        guest: { cpuKind: `shared` as const, cpus: 4, memoryMb: 8192 },
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

    // The guest is the rung's, not a constant: a ladder with a dedicated-CPU rung on it must reach Fly as one.
    it(`passes the run's own CPU kind through rather than assuming a shared one`, () => {
        expect(flyMachineConfig({ ...run, guest: { ...run.guest, cpuKind: `performance`, cpus: 2 } }).guest).toEqual({
            cpu_kind: `performance`,
            cpus: 2,
            memory_mb: 8192,
        });
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

// Reached only down the tunnel its daemon dials, like every sandbox: nothing on Fly routes to a hosted machine, so it
// declares no public service and no check, which Fly would otherwise run and report against a door nobody uses.
describe(`flyMachineConfig: no front door`, () => {
    it(`declares no service and no check`, () => {
        const config = flyMachineConfig({
            name: `intentic-sbx-abcdef012345`,
            image: `ghcr.io/intentic/sandbox:stable`,
            baseImage: `ghcr.io/intentic/sandbox:stable`,
            guest: { cpuKind: `shared` as const, cpus: 2, memoryMb: 4096 },
            volumeId: `vol_123`,
        });
        expect(config).not.toHaveProperty(`services`);
        expect(config).not.toHaveProperty(`checks`);
    });
});

describe(`flyMachineConfig: an overlay-built image`, () => {
    const run = {
        name: `intentic-sbx-abcdef012345`,
        image: `registry.fly.io/intentic-sbx-abcdef012345:env-0123456789ab`,
        baseImage: `ghcr.io/intentic/sandbox:stable`,
        guest: { cpuKind: `shared` as const, cpus: 4, memoryMb: 4096 },
        volumeId: `vol_123`,
    };

    // Derives "applied" from this hash against the approved file's, as on a docker host ic recreates.
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
        expect(config).not.toHaveProperty(`services`);
        expect(config).not.toHaveProperty(`checks`);
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
