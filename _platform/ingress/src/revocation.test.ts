import { describe, expect, test, vi } from "vitest";
import { createRevocation } from "./revocation.js";

const answering = (status: number): typeof fetch =>
    vi.fn(() => Promise.resolve(new Response(status === 404 ? `gone` : `ok`, { status }))) as unknown as typeof fetch;

describe(`createRevocation`, () => {
    test(`asks the platform about the sandbox by its 12-hex id`, async () => {
        const fetchImpl = answering(200);
        const revocation = createRevocation({ platformUrl: `https://api.example.test`, fetchImpl });

        await expect(revocation.allows(`abcdef012345`)).resolves.toBe(true);
        expect(fetchImpl).toHaveBeenCalledWith(`https://api.example.test/api/reachability/abcdef012345`, expect.anything());
    });

    // A trailing slash on PLATFORM_URL must not produce a double slash the platform answers 404 to — which
    // would read as "this sandbox is revoked" and refuse every tunnel on the deployment.
    test(`tolerates a trailing slash on the platform address`, async () => {
        const fetchImpl = answering(200);
        const revocation = createRevocation({ platformUrl: `https://api.example.test/`, fetchImpl });

        await revocation.allows(`abcdef012345`);
        expect(fetchImpl).toHaveBeenCalledWith(`https://api.example.test/api/reachability/abcdef012345`, expect.anything());
    });

    // 404 is the ONLY refusal: it is what deleting the sandbox row looks like from here.
    test(`refuses a sandbox the platform says is gone`, async () => {
        const revocation = createRevocation({ platformUrl: `https://api.example.test`, fetchImpl: answering(404) });
        await expect(revocation.allows(`abcdef012345`)).resolves.toBe(false);
    });

    /* FAILING OPEN IS THE POINT. Reachability must not depend on the platform being up — otherwise a platform
     * outage becomes a total outage as every container's backoff brings it round to a refusal. */
    test(`registers the tunnel when the platform errors`, async () => {
        const revocation = createRevocation({ platformUrl: `https://api.example.test`, fetchImpl: answering(500) });
        await expect(revocation.allows(`abcdef012345`)).resolves.toBe(true);
    });

    test(`registers the tunnel when the platform cannot be reached at all`, async () => {
        const fetchImpl = vi.fn(() => Promise.reject(new Error(`ECONNREFUSED`))) as unknown as typeof fetch;
        const revocation = createRevocation({ platformUrl: `https://api.example.test`, fetchImpl });
        await expect(revocation.allows(`abcdef012345`)).resolves.toBe(true);
    });

    // A redial storm (an edge restart, a deploy) would otherwise ask the platform once per container within a
    // few seconds.
    test(`caches an answer for the ttl`, async () => {
        let clock = 0;
        const fetchImpl = answering(200);
        const revocation = createRevocation({ platformUrl: `https://api.example.test`, fetchImpl, ttlMs: 1_000, now: () => clock });

        await revocation.allows(`abcdef012345`);
        await revocation.allows(`abcdef012345`);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        clock += 1_001;
        await revocation.allows(`abcdef012345`);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    // Fail-open is a decision to DEFER, so caching it would defer for the whole window and turn a one-second
    // platform blip into a minute of unchecked registrations.
    test(`never caches a failure`, async () => {
        const fetchImpl = answering(503);
        const revocation = createRevocation({ platformUrl: `https://api.example.test`, fetchImpl, ttlMs: 60_000 });

        await revocation.allows(`abcdef012345`);
        await revocation.allows(`abcdef012345`);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    // The right shape for a local run, and for an edge stood up before the platform knows about it.
    test(`is off entirely without a platform address`, async () => {
        const fetchImpl = answering(404);
        const revocation = createRevocation({ platformUrl: ``, fetchImpl });

        await expect(revocation.allows(`abcdef012345`)).resolves.toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(0);
    });
});

/* THE LANE, for a hostname no tunnel holds: the same question asked for the replay decision (server.ts), so it
 * rides the same cache and the same fail-open. */
describe(`createRevocation lookup`, () => {
    const answeringWith = (body: unknown, status = 200): typeof fetch =>
        vi.fn(() =>
            Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } })),
        ) as unknown as typeof fetch;

    test(`reads the lane and the app the platform names`, async () => {
        const revocation = createRevocation({
            platformUrl: `https://api.example.test`,
            fetchImpl: answeringWith({ ok: true, lane: `hosted`, app: `intentic-sbx-abcdef012345` }),
        });
        await expect(revocation.lookup(`abcdef012345`)).resolves.toEqual({ exists: true, lane: `hosted`, app: `intentic-sbx-abcdef012345` });
    });

    test(`reads a tunnel-lane sandbox as one with nothing to replay to`, async () => {
        const revocation = createRevocation({ platformUrl: `https://api.example.test`, fetchImpl: answeringWith({ ok: true, lane: `tunnel` }) });
        await expect(revocation.lookup(`abcdef012345`)).resolves.toEqual({ exists: true, lane: `tunnel` });
    });

    // An older platform answers `{ ok: true }` and nothing else: the sandbox exists, on a lane it will not name.
    test(`treats an answer that names no lane as existing on an unknown lane`, async () => {
        const revocation = createRevocation({ platformUrl: `https://api.example.test`, fetchImpl: answeringWith({ ok: true }) });
        await expect(revocation.lookup(`abcdef012345`)).resolves.toEqual({ exists: true });
    });

    test(`answers gone for a 404, and unknown-but-existing when the platform cannot be asked`, async () => {
        await expect(
            createRevocation({ platformUrl: `https://api.example.test`, fetchImpl: answeringWith({}, 404) }).lookup(`abcdef012345`),
        ).resolves.toEqual({ exists: false });
        const down = vi.fn(() => Promise.reject(new Error(`ECONNREFUSED`))) as unknown as typeof fetch;
        await expect(createRevocation({ platformUrl: `https://api.example.test`, fetchImpl: down }).lookup(`abcdef012345`)).resolves.toEqual({
            exists: true,
        });
    });

    // One answer serves both callers: a registration and a replay decision inside the TTL cost one request.
    test(`shares its cache with the registration gate`, async () => {
        const fetchImpl = answeringWith({ ok: true, lane: `hosted` });
        const revocation = createRevocation({ platformUrl: `https://api.example.test`, fetchImpl });
        await revocation.lookup(`abcdef012345`);
        await expect(revocation.allows(`abcdef012345`)).resolves.toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test(`answers unknown-but-existing with no platform configured, asking nobody`, async () => {
        const fetchImpl = answeringWith({});
        await expect(createRevocation({ platformUrl: ``, fetchImpl }).lookup(`abcdef012345`)).resolves.toEqual({ exists: true });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
