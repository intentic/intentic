import { describe, expect, it } from "vitest";
import { FLY_VOLUME_LAYOUT, FLY_VOLUME_PATH, flyMachineConfig } from "./fly.js";

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
