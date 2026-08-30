import { localDaemonUrlInsecure } from "@intentic/sandbox-run";
import { expect, it, vi } from "vitest";
import {
    candidatesFor,
    couldBeOnThisMachine,
    localDaemonUrl,
    probeEndpoint,
    PROMOTION_INTERVAL_MS,
    sandboxIdOf,
    selectEndpoint,
    settledEndpoint,
} from "./endpoint";

const TUNNEL = `https://sandbox-abc.example.com`;
const ZONE = `example.com`;
const TOKEN = `connect-token`;

// A sandbox with no machine record: the ordinary self-hosted lane, which is the one that might be a loopback
// hop away. The two records are what the cases below vary.
const anywhere = { cloud: null, hosted: null };

// The daemon's answer to GET /health. `id` undefined models a daemon too old to name itself.
const health = (id: string | undefined): Response =>
    new Response(JSON.stringify({ ok: true, sandboxId: id }), { status: 200, headers: { "content-type": `application/json` } });

it(`derives the sandbox id from the connect TOKEN, matching what the container published under`, async () => {
    // The digest, not the URL's leading label: on the own-Cloudflare path that label is a subdomain the owner
    // chose, and deriving the port from it would compute an address nothing is listening on.
    const id = await sandboxIdOf(TOKEN);
    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(await sandboxIdOf(TOKEN)).toBe(id);
    expect(await sandboxIdOf(`other`)).not.toBe(id);
});

it(`ranks by multiplexing, not by distance: the HTTP/1.1 address is last`, async () => {
    const id = await sandboxIdOf(TOKEN);
    const withToken = await candidatesFor({ daemonUrl: TUNNEL, token: TOKEN, ...anywhere });
    /* THE ORDER IS THE WHOLE POLICY, so it is asserted as a whole. The certified loopback speaks h2 and the
     * tunnel's edge speaks h2/h3; plain http is HTTP/1.1 and cannot be otherwise, because no browser speaks
     * cleartext h2. Six connections per origin against an app holding one long-lived stream per window plus one
     * per streaming agent is a workspace that freezes, so the un-multiplexed address goes BELOW the tunnel and
     * is reached only when nothing else answers, which is the outage it was written for. Put it back in the
     * middle and a missing DNS record silently downgrades every window again. */
    expect(withToken.map((candidate) => candidate.kind)).toEqual([`local`, `tunnel`, `local-insecure`]);
    expect(withToken[0]?.base).toBe(localDaemonUrl(id, ZONE));
    expect(withToken[1]?.base).toBe(TUNNEL);
    expect(withToken[2]?.base).toBe(localDaemonUrlInsecure(id));
    /* A label DEEPER than the sandbox's own hostname, and this is the assertion that keeps it there: a DNS
     * wildcard matches exactly one label, so `<id>.local.<zone>` is what lets one `*.local.<zone>` record
     * answer for every sandbox there will ever be. Flatten it back to `local-<id>.<zone>` and each sandbox
     * needs a record of its own again, which is what filled the zone's quota and took the certified shortcut
     * (and with it h2, and with it the workspace) down. */
    expect(new URL(withToken[0]!.base).hostname).toBe(`${id}.local.${ZONE}`);
    // Both loopback forms are the SAME published port: one mapping, and what the daemon serves decides.
    expect(new URL(withToken[0]!.base).port).toBe(new URL(withToken[2]!.base).port);

    // No token ⇒ no derivable id ⇒ no address to guess. The tunnel is the only way in.
    expect(await candidatesFor({ daemonUrl: TUNNEL, token: undefined, ...anywhere })).toEqual([{ kind: `tunnel`, base: TUNNEL }]);
});

it(`offers no loopback candidate for a machine the platform put somewhere this browser is not`, async () => {
    // The two lanes where the platform created the machine itself and knows where it is. Probing either would
    // spend the browser's Local Network Access prompt: the "is this app looking around my computer" dialog:
    // on an address that could never have answered.
    const hosted = await candidatesFor({ daemonUrl: TUNNEL, token: TOKEN, cloud: null, hosted: { state: `started` } });
    expect(hosted).toEqual([{ kind: `tunnel`, base: TUNNEL }]);
    const cloud = await candidatesFor({ daemonUrl: TUNNEL, token: TOKEN, cloud: { provider: `hetzner` }, hosted: null });
    expect(cloud).toEqual([{ kind: `tunnel`, base: TUNNEL }]);

    // …and the verdict itself, which is a cheap NO and never a yes: no machine record means the sandbox MIGHT
    // be a loopback hop away, which is the whole reason the probe still exists.
    expect(couldBeOnThisMachine(anywhere)).toBe(true);
    expect(couldBeOnThisMachine({ cloud: null, hosted: { state: `started` } })).toBe(false);
    expect(couldBeOnThisMachine({ cloud: { provider: `hetzner` }, hosted: null })).toBe(false);
});

it(`never reaches for the machine when the sandbox cannot be on it`, async () => {
    const fetchMock = vi.fn();
    expect(await selectEndpoint({ daemonUrl: TUNNEL, token: TOKEN, cloud: null, hosted: { state: `started` } }, fetchMock)).toEqual({
        kind: `tunnel`,
        base: TUNNEL,
    });
    // The point of the gate: not merely that the tunnel wins, but that nothing was fetched to decide it.
    expect(fetchMock).not.toHaveBeenCalled();
});

it(`drops the certified candidate when the sandbox's URL carries no zone to certify under`, async () => {
    // A two-label host has no zone suffix to strip: an attached sandbox behind someone's own bare domain. It
    // can never have a certificate, so it rides the tunnel and only drops to plain http when offline.
    const candidates = await candidatesFor({ daemonUrl: `https://example.com`, token: TOKEN, ...anywhere });
    expect(candidates.map((candidate) => candidate.kind)).toEqual([`tunnel`, `local-insecure`]);
});

it(`accepts a loopback candidate only when the daemon behind it names THIS sandbox`, async () => {
    const id = await sandboxIdOf(TOKEN);
    const local = { kind: `local` as const, base: localDaemonUrl(id, ZONE)! };

    expect(
        await probeEndpoint(
            local,
            id,
            vi.fn(async () => health(id)),
        ),
    ).toBe(true);
    // Something is listening, but it is another sandbox: adopting it would point this sandbox's session,
    // uploads and terminals at a different daemon. This is the case a liveness-only probe gets wrong.
    expect(
        await probeEndpoint(
            local,
            id,
            vi.fn(async () => health(`0123456789ab`)),
        ),
    ).toBe(false);
    // A daemon predating the id (nothing to match) is not adopted either: silence is not agreement.
    expect(
        await probeEndpoint(
            local,
            id,
            vi.fn(async () => health(undefined)),
        ),
    ).toBe(false);
    // Not a daemon at all: some other dev server holding the port.
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
    const local = { kind: `local` as const, base: localDaemonUrl(id, ZONE)! };
    // Safari refusing it as mixed content, Chrome's Local Network Access permission being declined, and
    // nothing listening all surface as a rejected fetch: none of them are worth telling apart.
    const refused = vi.fn(async () => {
        throw new TypeError(`Failed to fetch`);
    });
    expect(await probeEndpoint(local, id, refused)).toBe(false);
});

it(`qualifies the tunnel too, now that something ranks below it`, async () => {
    /* It was never probed while it sat last, which was coherent: nothing follows a fallback. Ranked above the
     * plain-http address it has to be qualified like anything else, or it always wins and the offline case
     * behind it is dead code. */
    const id = await sandboxIdOf(TOKEN);
    const tunnel = { kind: `tunnel` as const, base: TUNNEL };
    const answering = vi.fn(async () => health(id));
    expect(await probeEndpoint(tunnel, id, answering)).toBe(true);
    expect(answering).toHaveBeenCalledWith(`${TUNNEL}/health`, expect.anything());

    const offline = vi.fn(async () => {
        throw new TypeError(`Failed to fetch`);
    });
    expect(await probeEndpoint(tunnel, id, offline)).toBe(false);
});

it(`takes the tunnel on trust when nothing ranks below it`, async () => {
    // Qualifying the last candidate spends a request to choose between it and nothing. For a sandbox on a
    // machine the platform placed elsewhere it is also the only candidate there has ever been.
    const fetchMock = vi.fn();
    expect(await selectEndpoint({ daemonUrl: TUNNEL, token: TOKEN, cloud: null, hosted: { state: `started` } }, fetchMock)).toEqual({
        kind: `tunnel`,
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
        base: localDaemonUrl(id, ZONE),
    });

    /* NO CERTIFICATE, BUT ONLINE: the tunnel, not the plain loopback sitting right there. This is the case the
     * whole incident was: the certified name stopped resolving, and every window stepped down to HTTP/1.1
     * while a healthy h2/h3 tunnel went unused. Slower per request, and the only thing that makes an app
     * holding a dozen live streams usable. */
    const noCertificate = vi.fn(async (input: string | URL | Request) => {
        if (String(input).startsWith(localDaemonUrl(id, ZONE)!)) {
            throw new TypeError(`Failed to fetch`);
        }
        return health(id);
    }) as unknown as typeof fetch;
    expect(await selectEndpoint({ daemonUrl: TUNNEL, token: TOKEN, ...anywhere }, noCertificate)).toEqual({ kind: `tunnel`, base: TUNNEL });

    /* OFFLINE: neither public address resolves, and the daemon is a loopback hop away. This is the one state
     * plain http exists for, and the only one that reaches it. */
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

    // No shortcut is not a failure: a sandbox on someone else's machine is the ordinary case, and the tunnel
    // is a working address, so selection still returns one rather than erroring.
    expect(
        await selectEndpoint(
            { daemonUrl: TUNNEL, token: TOKEN, ...anywhere },
            vi.fn(async () => {
                throw new TypeError(`Failed to fetch`);
            }),
        ),
    ).toEqual({ kind: `tunnel`, base: TUNNEL });
});

/* THE ANSWER THAT EXPIRES, and why exactly one of the three does.
 *
 * A window that opens before its sandbox has a certificate qualifies plain http, and h2 arrives a minute
 * later. Without an expiry that window holds HTTP/1.1 — six connections per origin, the cap the stream budget
 * exists to ration — for as long as it stays open, which on a healthy stream is hours. It is the ordinary
 * experience of opening a sandbox you just created, not a corner case. */
it(`keeps the tunnel and the certified shortcut for good, and only ages out the plain one`, () => {
    const now = 1_000_000;
    const stale = now - PROMOTION_INTERVAL_MS - 1;
    for (const kind of [`tunnel`, `local`] as const) {
        // Nothing better exists to promote to, so re-probing could only cost a request and a permission prompt.
        expect(settledEndpoint({ kind, base: TUNNEL }, stale, now)).toBe(true);
    }
    expect(settledEndpoint({ kind: `local-insecure`, base: TUNNEL }, stale, now)).toBe(false);
    // Inside the interval it stands: the certificate does not arrive faster for being asked about twice.
    expect(settledEndpoint({ kind: `local-insecure`, base: TUNNEL }, now - 1, now)).toBe(true);
});

it(`treats an undated answer as fresh rather than expired`, () => {
    // "Just now" is the safe reading: aging out an answer on evidence that does not exist would re-probe on
    // every frame, and the interval costs at most one round of staleness.
    expect(settledEndpoint({ kind: `local-insecure`, base: TUNNEL }, undefined, 1_000_000)).toBe(true);
});

it(`has nothing to say about a sandbox with no answer yet: that is the probe's job`, () => {
    expect(settledEndpoint(undefined, undefined, 1_000_000)).toBe(false);
});
