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

/* WHICH ADDRESS THE AGENT DIALS, exercised against real daemons on real loopback ports, because the property
 * under test is not "does the code branch" but "does an HTTP answer from a port convince it".
 *
 * INTEGRATION-named for the reason tunnel's suite is: the adoption cases have to serve on the port the
 * derivation actually lands on (a candidate on any other port is not the candidate), which is a fixed number on
 * the shared machine, and one case deliberately waits out the real probe budget. Neither belongs under a hang
 * detector sized for pure functions. */

// A sandbox on the intentic-provided path: the public URL's leading label IS the daemon's 12-hex id, which is
// what makes both halves of the shortcut derivable (the port to dial, and the id /health must answer with).
const ID = `0738cd6b5027`;
const pairing: DaemonTarget = { sandboxId: `sandbox-${ID}-example-dev`, sandboxUrl: `https://sandbox-${ID}.example.dev` };
// Derived, never transcribed: the port is the run contract's to decide (@intentic/sandbox-run), and a copy of
// the arithmetic here would keep passing after the band moved.
const LOCAL = `http://127.0.0.1:${localDaemonPort(ID)}`;
const PUBLIC = pairing.sandboxUrl;

const servers: Server[] = [];

afterEach(async () => {
    // closeAllConnections as well as close: the hung-daemon case leaves a socket the probe abandoned, and
    // `close` alone waits for it, which would hold the port the next test derives the same number for.
    await Promise.all(
        servers.splice(0).map(async (server) => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }),
    );
});

/* A daemon on the port a sandbox id derives, answering /health the way the real one does. `answersAs` is whose
 * id it claims: the whole point of the probe is that this is not always the sandbox we asked about. `hang`
 * accepts the connection and never replies, which is what a container mid-boot or a wedged process looks like
 * from here — and is NOT the same as a dead port, which refuses instantly. */
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

// Real fetch, with a record of every URL it was asked for: how the tests prove what was NOT probed, which is
// half of what this module promises.
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

    /* The own-Cloudflare path, and the reason this is a gate rather than a nicety: the leading label there is a
     * subdomain the owner chose, so it derives a port nothing published AND leaves nothing to check an answer
     * against. An unprovable candidate is worse than no candidate — a daemon replying on that port could not be
     * shown to be the right one, and the sync token is what would go to it. */
    it(`refuses a label that is not a daemon id, so those pairings get no shortcut at all`, () => {
        expect(daemonIdOf(`https://myshop.example.com`)).toBeUndefined();
        expect(daemonIdOf(`https://sandbox-myshop.example.com`)).toBeUndefined();
        // Twelve hex is the shape; eleven and thirteen are not it.
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

    // The base is compared as a string (the tunnel pool rebinds when it changes), so a trailing slash must not
    // read as a different address.
    it(`normalizes the public address, because the resolved base is compared as a string`, () => {
        expect(candidateBases(`${PUBLIC}/`)).toEqual([LOCAL, PUBLIC]);
    });

    // A dev box whose public URL already IS the shortcut would otherwise probe an address it is about to fall
    // back to anyway.
    it(`collapses to one candidate when the public address is the shortcut`, () => {
        expect(candidateBases(LOCAL)).toEqual([LOCAL]);
    });
});

describe(`resolveDaemonBase`, () => {
    it(`adopts the loopback daemon that names the sandbox we asked about`, async () => {
        await daemonOn(localDaemonPort(ID), { answersAs: ID });
        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: LOCAL, local: true });
    });

    /* THE LEAK THE IDENTITY CHECK PREVENTS, and the single most important case in this file. A port is not a
     * sandbox: a second sandbox on this machine, a leftover container or an unrelated dev server can be holding
     * the number. Adopting it would present this enrollment's sync token to a stranger and then push the user's
     * workspace at it. A live, healthy, wrong daemon must therefore lose to the public URL. */
    it(`refuses a daemon that answers as a DIFFERENT sandbox`, async () => {
        await daemonOn(localDaemonPort(ID), { answersAs: `bce57bb9fe3b` });
        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: PUBLIC, local: false });
    });

    // The daemon that has no id to claim at all (no connect token: the local/test shape) is equally unprovable.
    // Named by OMITTING the claim rather than sending `undefined`, which is what such a daemon actually serves.
    it(`refuses a daemon that names no sandbox`, async () => {
        await daemonOn(localDaemonPort(ID), {});
        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: PUBLIC, local: false });
    });

    it(`falls back to the public address when nothing is listening`, async () => {
        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: PUBLIC, local: false });
    });

    /* A candidate that accepts the connection and never answers is the one failure a refused port does not
     * cover, and the one that could cost a whole watcher pass: the loop is sequential, so an unbounded wait here
     * stalls every later pairing's ports and commits behind it. It must cost the budget and then fall through. */
    it(`gives up on a daemon that accepts and never answers, and falls back`, async () => {
        await daemonOn(localDaemonPort(ID), { hang: true });
        const started = Date.now();

        expect(await resolveDaemonBase(PUBLIC)).toEqual({ base: PUBLIC, local: false });

        // Bounded, not unbounded: asserted as an upper bound well clear of the 1.5s budget, so this reads as a
        // hang detector rather than a latency measurement of a machine under load.
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    /* THE FLOOR IS NEVER PROBED. It is the registry's own answer and the address the enrollment was performed
     * against, so qualifying it would spend a request to choose between it and nothing — and on a pairing with
     * no shortcut it is the only candidate there has ever been. Proved by what was asked for, since a public
     * hostname that does not resolve would "pass" a weaker assertion by failing. */
    it(`asks the shortcut and never the public address`, async () => {
        const { impl, asked } = countingFetch();
        await daemonOn(localDaemonPort(ID), { answersAs: ID });

        await resolveDaemonBase(PUBLIC, impl);
        expect(asked).toEqual([`${LOCAL}/health`]);

        // …and with no shortcut to try, nothing is asked at all.
        await resolveDaemonBase(`https://myshop.example.com`, impl);
        expect(asked).toEqual([`${LOCAL}/health`]);
    });
});

/* THE CACHE, which is what lets the watcher re-resolve on its own tick cadence (every few seconds) without
 * probing on it. The two verdicts age differently on purpose, and these pin which is which. */
describe(`createDaemonBases`, () => {
    const said: string[] = [];
    const log = (line: string): void => void said.push(line);

    afterEach(() => {
        said.length = 0;
    });

    it(`resolves a loopback verdict once and then holds it: the best address there is, nothing to re-ask`, async () => {
        const { impl, asked } = countingFetch();
        await daemonOn(localDaemonPort(ID), { answersAs: ID });
        // Far past the promotion interval, to show it is the KIND of verdict that settles it, not the clock.
        let clock = 0;
        const bases = createDaemonBases(log, impl, () => clock);

        expect(await bases.resolve(pairing)).toBe(LOCAL);
        clock = PROMOTION_INTERVAL_MS * 10;
        expect(await bases.resolve(pairing)).toBe(LOCAL);

        expect(asked).toHaveLength(1);
        // Said once, because a user reading mirror.log is entitled to know their sync stopped leaving the machine.
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
        // Nothing is said: the public address is the ordinary case and it is already on every other log line.
        expect(said).toEqual([]);
    });

    /* THE CASE THE INTERVAL EXISTS FOR: the laptop starts the sandbox AFTER the watcher. Docker comes up second
     * at login, or the user runs `docker compose up` an hour in. Nothing re-asks on its own — the watcher is
     * resident for the whole session — so without this the pairing spends the rest of the day pushing gigabytes
     * through the edge while the container sits one loopback hop away. */
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

    /* THE OTHER DIRECTION: the container goes away (stopped, deleted, recreated onto another port). The dialler
     * says so, and the pairing must fall back to an address that works rather than failing. */
    it(`demotes to the public address when a loopback base stops answering`, async () => {
        const { impl } = countingFetch();
        await daemonOn(localDaemonPort(ID), { answersAs: ID });
        let clock = 0;
        const bases = createDaemonBases(log, impl, () => clock);
        expect(await bases.resolve(pairing)).toBe(LOCAL);

        // The container is gone, and the ports poll that noticed reports it.
        await Promise.all(
            servers.splice(0).map(async (server) => {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }),
        );
        bases.failed(pairing.sandboxId);
        clock += 1; // the very next tick, not a minute later: a dead base is not something to sit on

        expect(await bases.resolve(pairing)).toBe(PUBLIC);
        expect(said.join("\n")).toContain(`stopped answering as this sandbox`);
    });

    /* A FAILING FALLBACK IS LEFT ALONE, which is the asymmetry worth pinning: there is nothing under the public
     * address to fall to, so re-probing on every failure would buy a probe per tick for a sandbox that is merely
     * asleep — the ordinary state of a laptop — and change nothing about the answer. */
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

    // One verdict per sandbox: a machine syncing a fleet resolves each independently, and one sandbox's dead
    // container says nothing about another's.
    it(`keeps a verdict per sandbox`, async () => {
        const { impl } = countingFetch();
        await daemonOn(localDaemonPort(ID), { answersAs: ID });
        const other: DaemonTarget = { sandboxId: `sandbox-bce57bb9fe3b-example-dev`, sandboxUrl: `https://sandbox-bce57bb9fe3b.example.dev` };
        const bases = createDaemonBases(log, impl, () => 0);

        expect(await bases.resolve(pairing)).toBe(LOCAL);
        expect(await bases.resolve(other)).toBe(other.sandboxUrl);
    });
});
