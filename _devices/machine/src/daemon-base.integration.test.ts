import { createServer, type Server } from "node:http";
import { localDaemonPort } from "@intentic/sandbox-run";
import { afterEach, describe, expect, it } from "vitest";
import {
    candidateBases,
    createDaemonBases,
    daemonIdOf,
    type DaemonTarget,
    PROMOTION_INTERVAL_MS,
    resolveDaemonBase,
} from "./daemon-base.js";

// Exercises daemon resolution against real daemons on real loopback ports; the question is whether an HTTP answer
// convinces it, not whether the code branches. Cases must serve on the exact derived port, and one waits out the real
// probe budget, hence integration-named.

// The URL's leading label is the daemon's 12-hex id, deriving the port to dial and the id /health answers.
const ID = `0738cd6b5027`;
const pairing: DaemonTarget = { sandboxId: `sandbox-${ID}-example-dev`, sandboxUrl: `https://sandbox-${ID}.example.dev` };
// Derived, not transcribed: the port is @intentic/sandbox-run's contract to decide.
const LOCAL = `http://127.0.0.1:${localDaemonPort(ID)}`;
const PUBLIC = pairing.sandboxUrl;

const servers: Server[] = [];

afterEach(async () => {
    // closeAllConnections plus close: hung-daemon case leaves an abandoned socket that close alone would wait on.
    await Promise.all(
        servers.splice(0).map(async (server) => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }),
    );
});

// A daemon on a port, answering /health like the real one. `answersAs` sets which sandbox id it claims (not always the
// one asked about); `hang` accepts and never replies, unlike a dead port which refuses instantly.
const daemonOn = async (port: number, { answersAs, hang = false }: { answersAs?: string; hang?: boolean }): Promise<void> => {
    const server = createServer((request, response) => {
        if (hang) {
            return; // connection accepted, answer never sent
        }
        if (request.url !== `/health`) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, sandboxId: answersAs }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, `127.0.0.1`, resolve));
};

// Real fetch that records every URL asked, to prove what was NOT probed.
const countingFetch = (): { readonly impl: typeof fetch; readonly asked: string[] } => {
    const asked: string[] = [];
    return {
        asked,
        impl: async (input, init) => {
            asked.push(String(input));
            return await fetch(input, init);
        },
    };
};

describe(`daemonIdOf`, () => {
    it(`reads the daemon's id off its public address`, () => {
        expect(daemonIdOf(PUBLIC)).toBe(ID);
    });

    // An unprovable candidate (a subdomain the owner chose, not a derived port) is worse than none: nothing could
    // confirm a daemon answering there is the right one to trust with the sync token.
    it(`refuses a label that is not a daemon id, so those pairings get no shortcut at all`, () => {
        expect(daemonIdOf(`https://myshop.example.com`)).toBeUndefined();
        expect(daemonIdOf(`https://sandbox-myshop.example.com`)).toBeUndefined();
        // Twelve hex is the shape; eleven and thirteen characters are not it.
        expect(daemonIdOf(`https://sandbox-0738cd6b502.example.dev`)).toBeUndefined();
        expect(daemonIdOf(`https://sandbox-0738cd6b50270.example.dev`)).toBeUndefined();
    });
});

describe(`candidateBases`, () => {
    it(`puts the loopback shortcut first and the public address last`, () => {
        expect(candidateBases(PUBLIC)).toEqual([LOCAL, PUBLIC]);
    });

    it(`is the public address alone when there is no id to derive a shortcut from`, () => {
        expect(candidateBases(`https://myshop.example.com`)).toEqual([`https://myshop.example.com`]);
    });

    // The resolved base is compared as a string, so a trailing slash must not read as a different address.
    it(`normalizes the public address, because the resolved base is compared as a string`, () => {
        expect(candidateBases(`${PUBLIC}/`)).toEqual([LOCAL, PUBLIC]);
    });

    // A public URL that's already the shortcut should not also be probed as a separate candidate.
    it(`collapses to one candidate when the public address is the shortcut`, () => {
        expect(candidateBases(LOCAL)).toEqual([LOCAL]);
    });
});

describe(`resolveDaemonBase`, () => {
    it(`adopts the loopback daemon that names the sandbox we asked about`, async () => {
        await daemonOn(localDaemonPort(ID), { answersAs: ID });
        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: LOCAL, local: true });
    });

    // A port isn't a sandbox: an unrelated daemon holding it must lose to the public URL, or its enrollment token goes
    // to a stranger.
    it(`refuses a daemon that answers as a DIFFERENT sandbox`, async () => {
        await daemonOn(localDaemonPort(ID), { answersAs: `bce57bb9fe3b` });
        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: PUBLIC, local: false });
    });

    // A daemon with no id to claim (no connect token) is equally unprovable; the claim is omitted, not sent as
    // `undefined`.
    it(`refuses a daemon that names no sandbox`, async () => {
        await daemonOn(localDaemonPort(ID), {});
        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: PUBLIC, local: false });
    });

    it(`falls back to the public address when nothing is listening`, async () => {
        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: PUBLIC, local: false });
    });

    // An accepting-but-silent daemon is the one failure a refused port misses, and the costliest since the loop is
    // sequential: it must cost its budget and fall through, not hang the whole pass.
    it(`gives up on a daemon that accepts and never answers, and falls back`, async () => {
        await daemonOn(localDaemonPort(ID), { hang: true });
        const started = Date.now();

        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: PUBLIC, local: false });

        // Asserted well clear of the 1.5s budget: a hang detector, not a latency measurement.
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    // The floor address is never probed: it's the registry's own answer, so qualifying it would spend a request
    // choosing between it and nothing.
    it(`asks the shortcut and never the public address`, async () => {
        const { impl, asked } = countingFetch();
        await daemonOn(localDaemonPort(ID), { answersAs: ID });

        await resolveDaemonBase(PUBLIC, impl);
        expect(asked).toEqual([`${LOCAL}/health`]);

        // With no shortcut to try, nothing is asked at all.
        await resolveDaemonBase(`https://myshop.example.com`, impl);
        expect(asked).toEqual([`${LOCAL}/health`]);
    });
});

// The cache lets the watcher re-resolve on its tick cadence without probing every time; the two verdicts (loopback,
// fallback) age differently, pinned here.
describe(`createDaemonBases`, () => {
    const said: string[] = [];
    const log = (line: string): void => void said.push(line);

    afterEach(() => {
        said.length = 0;
    });

    it(`resolves a loopback verdict once and then holds it: the best address there is, nothing to re-ask`, async () => {
        const { impl, asked } = countingFetch();
        await daemonOn(localDaemonPort(ID), { answersAs: ID });
        // Far past the promotion interval, to show the verdict itself settles this, not the clock.
        let clock = 0;
        const bases = createDaemonBases(log, impl, () => clock);

        expect(await bases.resolve(pairing)).toBe(LOCAL);
        clock = PROMOTION_INTERVAL_MS * 10;
        expect(await bases.resolve(pairing)).toBe(LOCAL);

        expect(asked).toHaveLength(1);
        // Said once: a user reading the log is entitled to know sync stopped leaving the machine.
        expect(said).toHaveLength(1);
        expect(said[0]).toContain(LOCAL);
    });

    it(`holds a fallback verdict for the interval, so a tick every few seconds costs no probe`, async () => {
        const { impl, asked } = countingFetch();
        let clock = 0;
        const bases = createDaemonBases(log, impl, () => clock);

        expect(await bases.resolve(pairing)).toBe(PUBLIC);
        clock = PROMOTION_INTERVAL_MS - 1;
        expect(await bases.resolve(pairing)).toBe(PUBLIC);

        expect(asked).toHaveLength(1);
        // Nothing is said: the public address is the ordinary case, already on every other log line.
        expect(said).toEqual([]);
    });

    // The case the interval exists for: a container starting after the watcher. Nothing re-asks on its own, so without
    // this the pairing stays on the public address indefinitely.
    it(`promotes a pairing onto loopback once the container appears, with no restart`, async () => {
        const { impl, asked } = countingFetch();
        let clock = 0;
        const bases = createDaemonBases(log, impl, () => clock);

        expect(await bases.resolve(pairing)).toBe(PUBLIC);

        await daemonOn(localDaemonPort(ID), { answersAs: ID });
        clock = PROMOTION_INTERVAL_MS;

        expect(await bases.resolve(pairing)).toBe(LOCAL);
        expect(asked).toHaveLength(2);
        expect(said.join("\n")).toContain(`syncing over loopback`);
    });

    // The other direction: the container disappears, and the dialler's failure must demote the pairing back to a
    // working address.
    it(`demotes to the public address when a loopback base stops answering`, async () => {
        const { impl } = countingFetch();
        await daemonOn(localDaemonPort(ID), { answersAs: ID });
        let clock = 0;
        const bases = createDaemonBases(log, impl, () => clock);
        expect(await bases.resolve(pairing)).toBe(LOCAL);

        // The container is gone; the ports poll that noticed reports it.
        await Promise.all(
            servers.splice(0).map(async (server) => {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }),
        );
        bases.failed(pairing.sandboxId);
        clock += 1; // the very next tick, not later: a dead base shouldn't be sat on.

        expect(await bases.resolve(pairing)).toBe(PUBLIC);
        expect(said.join("\n")).toContain(`stopped answering as this sandbox`);
    });

    // A failing fallback is left alone: nothing exists under the public address to fall to, so re-probing on every
    // failure would waste a probe on a merely-asleep sandbox.
    it(`keeps a fallback verdict when the dialler reports a failure`, async () => {
        const { impl, asked } = countingFetch();
        let clock = 0;
        const bases = createDaemonBases(log, impl, () => clock);
        expect(await bases.resolve(pairing)).toBe(PUBLIC);

        bases.failed(pairing.sandboxId);
        clock += 1;

        expect(await bases.resolve(pairing)).toBe(PUBLIC);
        expect(asked).toHaveLength(1);
    });

    // One verdict per sandbox: a fleet resolves independently, so one dead container says nothing about another's.
    it(`keeps a verdict per sandbox`, async () => {
        const { impl } = countingFetch();
        await daemonOn(localDaemonPort(ID), { answersAs: ID });
        const other: DaemonTarget = { sandboxId: `sandbox-bce57bb9fe3b-example-dev`, sandboxUrl: `https://sandbox-bce57bb9fe3b.example.dev` };
        const bases = createDaemonBases(log, impl, () => 0);

        expect(await bases.resolve(pairing)).toBe(LOCAL);
        expect(await bases.resolve(other)).toBe(other.sandboxUrl);
    });
});
