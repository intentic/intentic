import { PREVIEW_PORT } from "@intentic/constants";
import { describe, expect, it } from "vitest";
import { FLY_VOLUME_LAYOUT, FLY_VOLUME_PATH, FRONT_DOOR_CONCURRENCY, flyMachineConfig } from "./fly.js";

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
