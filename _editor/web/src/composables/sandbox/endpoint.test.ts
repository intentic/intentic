import { localDaemonUrl, localDaemonUrlInsecure } from "@intentic/sandbox-run";
import { expect, it, vi } from "vitest";
import { candidatesFor, probeEndpoint, sandboxIdOf, selectEndpoint } from "./endpoint";

const TUNNEL = `https://sandbox-abc.example.com`;
const ZONE = `example.com`;
const TOKEN = `connect-token`;

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

it(`orders candidates certified, plain, tunnel — the last one always dialable`, async () => {
    const id = await sandboxIdOf(TOKEN);
    const withToken = await candidatesFor({ daemonUrl: TUNNEL, token: TOKEN });
    // HTTPS leads because it is the only form Safari will touch; plain http follows for the window before a
    // certificate exists, where Chrome and Firefox still take the shortcut.
    expect(withToken.map((candidate) => candidate.kind)).toEqual([`local`, `local-insecure`, `tunnel`]);
    expect(withToken[0]?.base).toBe(localDaemonUrl(id, ZONE));
    expect(withToken[1]?.base).toBe(localDaemonUrlInsecure(id));
    expect(withToken[2]?.base).toBe(TUNNEL);
    // Both loopback forms are the SAME published port — one mapping, and what the daemon serves decides.
    expect(new URL(withToken[0]!.base).port).toBe(new URL(withToken[1]!.base).port);

    // No token ⇒ no derivable id ⇒ no address to guess. The tunnel is the only way in.
    expect(await candidatesFor({ daemonUrl: TUNNEL, token: undefined })).toEqual([{ kind: `tunnel`, base: TUNNEL }]);
});

it(`drops the certified candidate when the sandbox's URL carries no zone to certify under`, async () => {
    // A two-label host has no zone suffix to strip — an attached sandbox behind someone's own bare domain.
    const candidates = await candidatesFor({ daemonUrl: `https://example.com`, token: TOKEN });
    expect(candidates.map((candidate) => candidate.kind)).toEqual([`local-insecure`, `tunnel`]);
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
    // Something is listening, but it is another sandbox — adopting it would point this sandbox's session,
    // uploads and terminals at a different daemon. This is the case a liveness-only probe gets wrong.
    expect(
        await probeEndpoint(
            local,
            id,
            vi.fn(async () => health(`0123456789ab`)),
        ),
    ).toBe(false);
    // A daemon predating the id (nothing to match) is not adopted either — silence is not agreement.
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
    // nothing listening all surface as a rejected fetch — none of them are worth telling apart.
    const refused = vi.fn(async () => {
        throw new TypeError(`Failed to fetch`);
    });
    expect(await probeEndpoint(local, id, refused)).toBe(false);
});

it(`never probes the tunnel — it is the fallback, not a candidate to qualify`, async () => {
    const fetchMock = vi.fn();
    expect(await probeEndpoint({ kind: `tunnel`, base: TUNNEL }, `abc`, fetchMock)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
});

it(`selects the shortcut when it answers as us, and always resolves to something dialable`, async () => {
    const id = await sandboxIdOf(TOKEN);
    expect(
        await selectEndpoint(
            { daemonUrl: TUNNEL, token: TOKEN },
            vi.fn(async () => health(id)),
        ),
    ).toEqual({
        kind: `local`,
        base: localDaemonUrl(id, ZONE),
    });

    // A daemon serving the shortcut in plain http (no certificate yet) fails the https probe and passes the
    // next one — the browsers that allow loopback http are accelerated without waiting on issuance.
    const httpOnly = vi.fn(async (input: string | URL | Request) => {
        if (String(input).startsWith(`https://local-`)) {
            throw new TypeError(`Failed to fetch`);
        }
        return health(id);
    }) as unknown as typeof fetch;
    expect(await selectEndpoint({ daemonUrl: TUNNEL, token: TOKEN }, httpOnly)).toEqual({
        kind: `local-insecure`,
        base: localDaemonUrlInsecure(id),
    });

    // No shortcut is not a failure: a sandbox on someone else's machine is the ordinary case, and the tunnel
    // is a working address, so selection still returns one rather than erroring.
    expect(
        await selectEndpoint(
            { daemonUrl: TUNNEL, token: TOKEN },
            vi.fn(async () => {
                throw new TypeError(`Failed to fetch`);
            }),
        ),
    ).toEqual({ kind: `tunnel`, base: TUNNEL });
});
