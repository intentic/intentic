import { describe, expect, it } from "vitest";
import { createBody, newPullProgress, parseInspect, pullProgressLine } from "./docker.js";

// Lines as the engine streams them for `POST /images/create`.
const line = (event: Record<string, unknown>): string => JSON.stringify(event);

describe(`pull progress`, () => {
    it(`is unknown until a layer reports a size, then a whole-image percentage weighted toward the download`, () => {
        const progress = newPullProgress();
        expect(pullProgressLine(progress, line({ status: `Pulling from onlyoffice/documentserver`, id: `9.4.0.1` }))).toBeUndefined();
        expect(pullProgressLine(progress, line({ status: `Pulling fs layer`, id: `a` }))).toBeUndefined();
        expect(pullProgressLine(progress, line({ status: `Downloading`, id: `a`, progressDetail: { current: 50, total: 100 } }))).toBe(43);
        expect(pullProgressLine(progress, line({ status: `Downloading`, id: `b`, progressDetail: { current: 0, total: 100 } }))).toBe(21);
        expect(pullProgressLine(progress, line({ status: `Download complete`, id: `a` }))).toBe(43);
        expect(pullProgressLine(progress, line({ status: `Download complete`, id: `b` }))).toBe(85);
        expect(pullProgressLine(progress, line({ status: `Extracting`, id: `a`, progressDetail: { current: 100, total: 100 } }))).toBe(100);
        expect(pullProgressLine(progress, line({ status: `Extracting`, id: `b`, progressDetail: { current: 0, total: 100 } }))).toBe(93);
        expect(pullProgressLine(progress, line({ status: `Pull complete`, id: `b` }))).toBe(100);
    });

    it(`counts a layer already on disk as downloaded`, () => {
        const progress = newPullProgress();
        expect(pullProgressLine(progress, line({ status: `Already exists`, id: `a` }))).toBe(85);
    });

    it(`throws the stream's own error line and skips a blank one`, () => {
        const progress = newPullProgress();
        expect(pullProgressLine(progress, ``)).toBeUndefined();
        expect(() => pullProgressLine(progress, line({ error: `manifest unknown` }))).toThrow(`manifest unknown`);
    });
});

describe(`container answers`, () => {
    it(`reads the running state, the published loopback port, the image and the environment out of an inspect`, () => {
        const state = parseInspect(
            JSON.stringify({
                State: { Running: true },
                Config: { Image: `onlyoffice/documentserver:9.4.0.1`, Env: [`JWT_SECRET=abc`, `PATH=/usr/bin`] },
                NetworkSettings: { Ports: { "80/tcp": [{ HostIp: `127.0.0.1`, HostPort: `41231` }], "443/tcp": null } },
            }),
        );
        expect(state).toEqual({ running: true, hostPort: 41231, image: `onlyoffice/documentserver:9.4.0.1`, env: [`JWT_SECRET=abc`, `PATH=/usr/bin`], labels: {}, restart: `no`, startedAt: 0 });
    });

    it(`reads a stopped container's port from what it was created with, since its live bindings are empty`, () => {
        const state = parseInspect(
            JSON.stringify({
                State: { Running: false, StartedAt: `2026-09-17T13:17:20.5Z` },
                Config: { Image: `x` },
                NetworkSettings: { Ports: {} },
                DeviceConfig: { PortBindings: { "80/tcp": [{ HostIp: `127.0.0.1`, HostPort: `43657` }] }, RestartPolicy: { Name: `unless-stopped` } },
            }),
        );
        expect(state).toEqual({ running: false, hostPort: 43657, image: `x`, env: [], labels: {}, restart: `unless-stopped`, startedAt: Math.floor(Date.parse(`2026-09-17T13:17:20.5Z`) / 1000) });
    });

    it(`reports no port for a container created without one, and the engine's zero time as never started`, () => {
        expect(parseInspect(JSON.stringify({ State: { Running: false, StartedAt: `0001-01-01T00:00:00Z` }, Config: { Image: `x` }, NetworkSettings: { Ports: {} } }))).toEqual({
            running: false,
            hostPort: undefined,
            image: `x`,
            env: [],
            labels: {},
            restart: `no`,
            startedAt: 0,
        });
    });

    it(`publishes port 80 on loopback only and names the sandbox for the container`, () => {
        const body = createBody({ image: `img:1`, env: [`A=1`], hostPort: 5000, labels: { owner: `intentic.onlyoffice` } });
        expect(body).toEqual({
            Image: `img:1`,
            Env: [`A=1`],
            Labels: { owner: `intentic.onlyoffice` },
            ExposedPorts: { "80/tcp": {} },
            DeviceConfig: {
                PortBindings: { "80/tcp": [{ HostIp: `127.0.0.1`, HostPort: `5000` }] },
                ExtraHosts: [`host.docker.internal:host-gateway`],
                RestartPolicy: { Name: `unless-stopped` },
            },
        });
    });
});
