import { describe, expect, it, vi } from "vitest";
import type { ContainerSpec, ContainerState, DockerEngine } from "./docker.js";
import { CONTAINER, CONTAINER_LABELS, DocumentServer, IMAGE, RESTART_POLICY, SETUP_DONE_MARKER } from "./document-server.js";

// The lifecycle against a scripted engine: what the owner's start does, what an open does after it, and what is
// recreated rather than reused.

interface Scripted {
    readonly engine: DockerEngine;
    readonly calls: string[];
    state: { container: ContainerState | undefined; image: boolean; off: string | undefined; healthy: boolean; setupDone: boolean };
}

const scripted = (initial: Partial<Scripted[`state`]> = {}): Scripted => {
    const calls: string[] = [];
    const state: Scripted[`state`] = { container: undefined, image: false, off: undefined, healthy: true, setupDone: true, ...initial };
    const engine: DockerEngine = {
        unreachable: async () => state.off,
        imagePresent: async () => state.image,
        pull: async (_ref, onProgress) => {
            calls.push(`pull`);
            onProgress(40);
            onProgress(100);
            state.image = true;
        },
        inspect: async () => state.container,
        create: async (name, spec: ContainerSpec) => {
            calls.push(`create ${name} ${spec.hostPort} ${spec.env.join(` `)}`);
            state.container = { running: false, hostPort: spec.hostPort, image: spec.image, env: [...spec.env], labels: spec.labels, restart: RESTART_POLICY, startedAt: 0 };
        },
        start: async (name) => {
            calls.push(`start ${name}`);
            state.container = state.container === undefined ? undefined : { ...state.container, running: true };
        },
        stop: async (name) => {
            calls.push(`stop ${name}`);
            state.container = state.container === undefined ? undefined : { ...state.container, running: false };
        },
        remove: async (name) => {
            calls.push(`remove ${name}`);
            state.container = undefined;
        },
        logs: async () => (state.setupDone ? `...\n${SETUP_DONE_MARKER}\n` : `ds:converter: started\n`),
    };
    return { engine, calls, state };
};

const server = (script: Scripted, log: string[] = []): DocumentServer =>
    new DocumentServer({
        engine: script.engine,
        image: IMAGE,
        secret: `sec`,
        log: (line) => log.push(line),
        healthy: async () => script.state.healthy,
        freePort: async () => 4321,
        sleep: async () => undefined,
    });

describe(`before the owner's first start`, () => {
    it(`reports docker off, then not started, and opens nothing on its own`, async () => {
        const off = scripted({ off: `Add the Docker capability on the Capabilities page to turn it on.` });
        expect(await server(off).ensureRunning()).toEqual({ state: `docker-off`, detail: off.state.off });
        const fresh = scripted();
        const docs = server(fresh);
        expect(await docs.status()).toEqual({ state: `not-started` });
        expect(await docs.ensureRunning()).toEqual({ state: `not-started` });
        expect(fresh.calls).toEqual([]);
        expect(docs.running()).toBeUndefined();
    });
});

describe(`the owner's start`, () => {
    it(`pulls once, creates the container with the secret and the private-address allowance, and waits for health`, async () => {
        const script = scripted();
        const docs = server(script);
        expect(await docs.start()).toEqual({ state: `starting` });
        await docs.settled();
        expect(script.calls).toEqual([`pull`, `create ${CONTAINER} 4321 JWT_ENABLED=true JWT_SECRET=sec JWT_HEADER=Authorization ALLOW_PRIVATE_IP_ADDRESS=true`, `start ${CONTAINER}`]);
        expect(await docs.status()).toEqual({ state: `ready` });
        expect(docs.running()).toEqual({ port: 4321 });
        // A second start is idle work: the container is up.
        expect(await docs.start()).toEqual({ state: `ready` });
    });

    it(`reports the pull as it goes`, async () => {
        const script = scripted();
        let seen: unknown;
        const docs = new DocumentServer({
            engine: {
                ...script.engine,
                pull: async (_ref, onProgress) => {
                    onProgress(37);
                    seen = await docs.status();
                    script.state.image = true;
                },
            },
            image: IMAGE,
            secret: `sec`,
            log: () => undefined,
            healthy: async () => true,
            freePort: async () => 1,
            sleep: async () => undefined,
        });
        await docs.start();
        await docs.settled();
        expect(seen).toEqual({ state: `pulling`, percent: 37 });
    });

    it(`surfaces a failed start as an error state with the engine's words`, async () => {
        const script = scripted();
        const failing = new DocumentServer({
            engine: { ...script.engine, pull: async () => { throw new Error(`manifest unknown`); } },
            image: IMAGE,
            secret: `sec`,
            log: () => undefined,
            healthy: async () => true,
            freePort: async () => 1,
            sleep: async () => undefined,
        });
        await failing.start();
        await failing.settled();
        expect(await failing.status()).toEqual({ state: `error`, detail: `manifest unknown` });
    });

    it(`tries again after a failure instead of holding the error`, async () => {
        const script = scripted();
        let attempts = 0;
        const docs = new DocumentServer({
            engine: {
                ...script.engine,
                pull: async (ref, onProgress) => {
                    attempts += 1;
                    if (attempts === 1) {
                        throw new Error(`registry timeout`);
                    }
                    await script.engine.pull(ref, onProgress);
                },
            },
            image: IMAGE,
            secret: `sec`,
            log: () => undefined,
            healthy: async () => true,
            freePort: async () => 1,
            sleep: async () => undefined,
        });
        await docs.start();
        await docs.settled();
        // Reported once to the next poll, then cleared: the card shows the failure and offers the start again.
        expect(await docs.ensureRunning()).toEqual({ state: `error`, detail: `registry timeout` });
        expect(await docs.ensureRunning()).toEqual({ state: `not-started` });
        expect(await docs.start()).toEqual({ state: `starting` });
        await docs.settled();
        expect(await docs.status()).toEqual({ state: `ready` });
    });
});

describe(`readiness`, () => {
    it(`waits for the entrypoint's final banner even though the healthcheck already answers`, async () => {
        const script = scripted({ image: true, setupDone: false });
        let polls = 0;
        const docs = new DocumentServer({
            engine: script.engine,
            image: IMAGE,
            secret: `sec`,
            log: () => undefined,
            healthy: async () => true,
            freePort: async () => 4321,
            // The banner shows up on the third poll, as fonts finish and the services come back.
            sleep: async () => {
                polls += 1;
                script.state.setupDone = polls >= 3;
            },
        });
        await docs.start();
        expect(await docs.status()).toEqual({ state: `starting` });
        await docs.settled();
        expect(polls).toBe(3);
        expect(docs.running()).toEqual({ port: 4321 });
    });
});

describe(`an open after that`, () => {
    it(`brings a stopped container back up without pulling`, async () => {
        const script = scripted({
            image: true,
            container: { running: false, hostPort: 5000, image: IMAGE, env: [`JWT_SECRET=sec`], labels: CONTAINER_LABELS, restart: RESTART_POLICY, startedAt: 0 },
        });
        const docs = server(script);
        expect(await docs.ensureRunning()).toEqual({ state: `starting` });
        await docs.settled();
        expect(script.calls).toEqual([`start ${CONTAINER}`]);
        expect(await docs.ensureRunning()).toEqual({ state: `ready` });
        expect(docs.running()).toEqual({ port: 5000 });
    });

    it(`recreates a container built from another image, another secret or without the restart policy`, async () => {
        const script = scripted({
            image: true,
            container: { running: true, hostPort: 5000, image: `onlyoffice/documentserver:8.2.3`, env: [`JWT_SECRET=old`], labels: CONTAINER_LABELS, restart: RESTART_POLICY, startedAt: 0 },
        });
        const log: string[] = [];
        const docs = server(script, log);
        await docs.ensureRunning();
        await docs.settled();
        expect(script.calls[0]).toBe(`remove ${CONTAINER}`);
        expect(script.calls[1]).toContain(`create ${CONTAINER} 4321`);
        expect(log.some((line) => line.includes(`recreating`))).toBe(true);
        expect(docs.running()).toEqual({ port: 4321 });
        // The same image and secret, but created before the restart policy existed: recreated once to get it.
        const older = scripted({ image: true, container: { running: true, hostPort: 5000, image: IMAGE, env: [`JWT_SECRET=sec`], labels: CONTAINER_LABELS, restart: `no`, startedAt: 0 } });
        const upgraded = server(older);
        await upgraded.ensureRunning();
        await upgraded.settled();
        expect(older.calls[0]).toBe(`remove ${CONTAINER}`);
        expect(older.calls[1]).toContain(`create ${CONTAINER} 4321`);
    });

    it(`notices a server that stopped answering and starts it again`, async () => {
        const script = scripted({ image: true, container: { running: true, hostPort: 5000, image: IMAGE, env: [`JWT_SECRET=sec`], labels: CONTAINER_LABELS, restart: RESTART_POLICY, startedAt: 0 } });
        const docs = server(script);
        await docs.ensureRunning();
        await docs.settled();
        expect(docs.running()).toEqual({ port: 5000 });
        script.state.healthy = false;
        expect(await docs.ensureRunning()).toEqual({ state: `starting` });
        expect(docs.running()).toBeUndefined();
        script.state.healthy = true;
        await docs.settled();
        expect(docs.running()).toEqual({ port: 5000 });
    });
});

// The container carries `restart: unless-stopped`, so once started it outlives every document anyone opened.
// Measured four hours after last use: 27 processes, 122 MB resident and 2.6 GB of swap.
describe(`the idle stop`, () => {
    const MINUTE = 60_000;
    const WINDOW = 30 * MINUTE;

    it(`holds a server that is still being asked for, and stops one nobody has asked for`, async () => {
        vi.useFakeTimers();
        try {
            const script = scripted();
            const log: string[] = [];
            const docs = server(script, log);
            await docs.start();
            await docs.settled();

            // A server just brought up counts as used; the clock starts at the healthcheck, not at zero.
            expect(await docs.stopIfIdle(WINDOW)).toBe(false);
            vi.advanceTimersByTime(WINDOW - MINUTE);
            expect(await docs.stopIfIdle(WINDOW)).toBe(false);

            // `running()` is the listener asking where to proxy, which is the only thing that refreshes the clock.
            expect(docs.running()).toEqual({ port: 4321 });
            vi.advanceTimersByTime(WINDOW - MINUTE);
            expect(await docs.stopIfIdle(WINDOW)).toBe(false);
            expect(script.calls).not.toContain(`stop ${CONTAINER}`);

            vi.advanceTimersByTime(2 * MINUTE);
            expect(await docs.stopIfIdle(WINDOW)).toBe(true);
            expect(script.calls).toContain(`stop ${CONTAINER}`);
            expect(docs.running()).toBeUndefined();
            expect(log.join(`\n`)).toContain(`stopped the document server`);
        } finally {
            vi.useRealTimers();
        }
    });

    // Stopped, not removed: the next open must find the SAME container on the port the editor was handed, or an idle
    // stop would cost an address as well as a restart.
    it(`comes back on the same container and port, without recreating it`, async () => {
        const script = scripted();
        const docs = server(script);
        await docs.start();
        await docs.settled();
        expect(await docs.stopIfIdle(0)).toBe(true);
        expect(script.state.container?.running).toBe(false);

        expect(await docs.ensureRunning()).toEqual({ state: `starting` });
        await docs.settled();
        expect(docs.running()).toEqual({ port: 4321 });
        expect(script.calls.filter((call) => call.startsWith(`create `))).toHaveLength(1);
    });

    it(`does not stop a server that was never up, nor one mid-start`, async () => {
        const never = scripted();
        expect(await server(never).stopIfIdle(0)).toBe(false);
        expect(never.calls).toEqual([]);

        // Mid-start: `start` leaves the work in flight, and stopping under it would race the healthcheck.
        const starting = scripted();
        const docs = server(starting);
        void docs.start();
        expect(await docs.stopIfIdle(0)).toBe(false);
        expect(starting.calls).not.toContain(`stop ${CONTAINER}`);
        await docs.settled();
    });
});
