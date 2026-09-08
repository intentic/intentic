import { localDaemonUrlInsecure } from "@intentic/sandbox-run";
import { expect, it, vi } from "vitest";
import {
    candidatesFor,
    certifiedLoopbackUrl,
    couldBeOnThisMachine,
    probeEndpoint,
    PROMOTION_INTERVAL_MS,
    sandboxIdOf,
    selectEndpoint,
    settledEndpoint,
} from "./endpoint";

const TUNNEL = `https://sandbox-abc.example.com`;
const TOKEN = `connect-token`;
// Deliberately under a different zone than the sandbox's own, since the platform's name need not match it.
const CERT_HOST = `abc123def456.local.example.com`;

// Self-hosted lane: no machine record, so it might be a loopback hop away.
const anywhere = { hosted: null, localHostname: CERT_HOST };

// Mocks GET /health; `id` undefined models a daemon too old to name itself.
const health = (id: string | undefined): Response =>
    new Response(JSON.stringify({ ok: true, sandboxId: id }), { status: 200, headers: { "content-type": `application/json` } });

it(`derives the sandbox id from the connect TOKEN, matching what the container published under`, async () => {
    const id = await sandboxIdOf(TOKEN);
    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(await sandboxIdOf(TOKEN)).toBe(id);
    expect(await sandboxIdOf(`other`)).not.toBe(id);
});

it(`ranks by multiplexing, not by distance: the HTTP/1.1 address is last`, async () => {
    const id = await sandboxIdOf(TOKEN);
    const withToken = await candidatesFor({ daemonUrl: TUNNEL, token: TOKEN, ...anywhere });
    expect(withToken.map((candidate) => candidate.kind)).toEqual([`local`, `public`, `local-insecure`]);
    expect(withToken[0]?.base).toBe(certifiedLoopbackUrl(id, CERT_HOST));
    expect(withToken[1]?.base).toBe(TUNNEL);
    expect(withToken[2]?.base).toBe(localDaemonUrlInsecure(id));
    expect(new URL(withToken[0]!.base).hostname).toBe(CERT_HOST);
    expect(new URL(withToken[0]!.base).port).toBe(new URL(withToken[2]!.base).port);

    expect(await candidatesFor({ daemonUrl: TUNNEL, token: undefined, ...anywhere })).toEqual([{ kind: `public`, base: TUNNEL }]);
});

it(`offers no loopback candidate for a machine the platform put somewhere this browser is not`, async () => {
    // Platform-hosted machine (`hosted: { state: "started" }`), which can never be a loopback hop away.
    const hosted = await candidatesFor({ daemonUrl: TUNNEL, token: TOKEN, hosted: { state: `started` } });
    expect(hosted).toEqual([{ kind: `public`, base: TUNNEL }]);

    expect(couldBeOnThisMachine(anywhere)).toBe(true);
    expect(couldBeOnThisMachine({ hosted: { state: `started` } })).toBe(false);
});

it(`never reaches for the machine when the sandbox cannot be on it`, async () => {
    const fetchMock = vi.fn();
    expect(await selectEndpoint({ daemonUrl: TUNNEL, token: TOKEN, hosted: { state: `started` } }, fetchMock)).toEqual({
        kind: `public`,
        base: TUNNEL,
    });
    expect(fetchMock).not.toHaveBeenCalled();
});

it(`drops the certified candidate when the platform reports no loopback name`, async () => {
    // `localHostname: null` means the platform reports no certified shortcut; a normal state, not a failure.
    const candidates = await candidatesFor({ daemonUrl: TUNNEL, token: TOKEN, hosted: null, localHostname: null });
    expect(candidates.map((candidate) => candidate.kind)).toEqual([`public`, `local-insecure`]);

    // Missing `localHostname` (older platform) is treated the same as null.
    const legacy = await candidatesFor({ daemonUrl: TUNNEL, token: TOKEN, hosted: null });
    expect(legacy.map((candidate) => candidate.kind)).toEqual([`public`, `local-insecure`]);
});

it(`accepts a loopback candidate only when the daemon behind it names THIS sandbox`, async () => {
    const id = await sandboxIdOf(TOKEN);
    const local = { kind: `local` as const, base: certifiedLoopbackUrl(id, CERT_HOST)! };

    expect(
        await probeEndpoint(
            local,
            id,
            vi.fn(async () => health(id)),
        ),
    ).toBe(true);
    expect(
        await probeEndpoint(
            local,
            id,
            vi.fn(async () => health(`0123456789ab`)),
        ),
    ).toBe(false);
    expect(
        await probeEndpoint(
            local,
            id,
            vi.fn(async () => health(undefined)),
        ),
    ).toBe(false);
    expect(
        await probeEndpoint(
            local,
            id,
            vi.fn(async () => new Response(`<html>`, { status: 200 })),
        ),
    ).toBe(false);
    expect(
        await probeEndpoint(
            local,
            id,
            vi.fn(async () => new Response(``, { status: 502 })),
        ),
    ).toBe(false);
});

it(`treats every way a loopback call can be refused as the same instruction: use the tunnel`, async () => {
    const id = await sandboxIdOf(TOKEN);
    const local = { kind: `local` as const, base: certifiedLoopbackUrl(id, CERT_HOST)! };
    // Models Safari's mixed-content refusal, a declined LNA prompt, and nothing listening: all reject the fetch the
    // same way.
    const refused = vi.fn(async () => {
        throw new TypeError(`Failed to fetch`);
    });
    expect(await probeEndpoint(local, id, refused)).toBe(false);
});

it(`qualifies the tunnel too, now that something ranks below it`, async () => {
    const id = await sandboxIdOf(TOKEN);
    const tunnel = { kind: `public` as const, base: TUNNEL };
    const answering = vi.fn(async () => health(id));
    expect(await probeEndpoint(tunnel, id, answering)).toBe(true);
    expect(answering).toHaveBeenCalledWith(`${TUNNEL}/health`, expect.anything());

    const offline = vi.fn(async () => {
        throw new TypeError(`Failed to fetch`);
    });
    expect(await probeEndpoint(tunnel, id, offline)).toBe(false);
});

it(`takes the tunnel on trust when nothing ranks below it`, async () => {
    const fetchMock = vi.fn();
    expect(await selectEndpoint({ daemonUrl: TUNNEL, token: TOKEN, hosted: { state: `started` } }, fetchMock)).toEqual({
        kind: `public`,
        base: TUNNEL,
    });
    expect(fetchMock).not.toHaveBeenCalled();
});

it(`selects the shortcut when it answers as us, and always resolves to something dialable`, async () => {
    const id = await sandboxIdOf(TOKEN);
    expect(
        await selectEndpoint(
            { daemonUrl: TUNNEL, token: TOKEN, ...anywhere },
            vi.fn(async () => health(id)),
        ),
    ).toEqual({
        kind: `local`,
        base: certifiedLoopbackUrl(id, CERT_HOST),
    });

    // Certificate lookup fails but everything else answers: falls to the tunnel, not the plain loopback.
    const noCertificate = vi.fn(async (input: string | URL | Request) => {
        if (String(input).startsWith(certifiedLoopbackUrl(id, CERT_HOST)!)) {
            throw new TypeError(`Failed to fetch`);
        }
        return health(id);
    }) as unknown as typeof fetch;
    expect(await selectEndpoint({ daemonUrl: TUNNEL, token: TOKEN, ...anywhere }, noCertificate)).toEqual({ kind: `public`, base: TUNNEL });

    // Only the plain loopback address answers: models being offline, which is what plain http exists for.
    const offline = vi.fn(async (input: string | URL | Request) => {
        if (!String(input).startsWith(localDaemonUrlInsecure(id))) {
            throw new TypeError(`Failed to fetch`);
        }
        return health(id);
    }) as unknown as typeof fetch;
    expect(await selectEndpoint({ daemonUrl: TUNNEL, token: TOKEN, ...anywhere }, offline)).toEqual({
        kind: `local-insecure`,
        base: localDaemonUrlInsecure(id),
    });

    expect(
        await selectEndpoint(
            { daemonUrl: TUNNEL, token: TOKEN, ...anywhere },
            vi.fn(async () => {
                throw new TypeError(`Failed to fetch`);
            }),
        ),
    ).toEqual({ kind: `public`, base: TUNNEL });
});

it(`keeps the tunnel and the certified shortcut for good, and only ages out the plain one`, () => {
    const now = 1_000_000;
    const stale = now - PROMOTION_INTERVAL_MS - 1;
    for (const kind of [`public`, `local`] as const) {
        expect(settledEndpoint({ kind, base: TUNNEL }, stale, now)).toBe(true);
    }
    expect(settledEndpoint({ kind: `local-insecure`, base: TUNNEL }, stale, now)).toBe(false);
    expect(settledEndpoint({ kind: `local-insecure`, base: TUNNEL }, now - 1, now)).toBe(true);
});

it(`treats an undated answer as fresh rather than expired`, () => {
    expect(settledEndpoint({ kind: `local-insecure`, base: TUNNEL }, undefined, 1_000_000)).toBe(true);
});

it(`has nothing to say about a sandbox with no answer yet: that is the probe's job`, () => {
    expect(settledEndpoint(undefined, undefined, 1_000_000)).toBe(false);
});
