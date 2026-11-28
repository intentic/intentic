import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyIdentityChange, openEnvelope, sealEnvelope, type TxtAnswer, verifyIdentity } from "@intentic/sandbox-contract/s2s";
import { S2sMeSchema, S2sRecoveryMintedSchema, type SandboxIdentity, SandboxIdentitySchema } from "@intentic/sandbox-contract/schemas/s2s";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { serveRawRoutes } from "../../http/raw-route-server.js";
import { identityRoutesOf } from "./identity.routes.js";
import { createS2sIdentity, type S2sRotation } from "./s2s-identity.js";

// The identity's routes over HTTP, on real files: the document every other daemon fetches, the Identity section's view,
// an own domain from its claim through its TXT check into the document, rotation with a prev the old key signed, and a
// recovery key shown once that brings the identity back on a sandbox whose volume was lost.

const HOST = `0123456789ab.sandbox.example`;
const DOMAIN = `ops.acme.example`;
const START = 1_800_000_000_000;

const setup = (root = mkdtempSync(join(tmpdir(), `s2s-identity-`))) => {
    const txt = new Map<string, TxtAnswer>();
    const clock = { now: START };
    const rotations: S2sRotation[] = [];
    const keysPath = join(root, `auth`, `sandbox-identity.json`);
    const identity = createS2sIdentity({
        keysPath,
        domainsPath: join(root, `history`, `s2s`, `identity-domains.json`),
        self: () => ({ sandbox: `0123456789ab`, name: `ops`, host: HOST }),
        resolveTxt: async (name) => txt.get(name) ?? { kind: `missing` },
        now: () => clock.now,
    });
    identity.onRotated((rotation) => rotations.push(rotation));
    const app = serveRawRoutes(new Hono<AppEnv>(), identityRoutesOf(identity));
    const call = async (method: string, path: string, body?: object) => {
        const response = await app.request(path, { method, headers: { "content-type": `application/json` }, body: body === undefined ? null : JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    };
    const served = async (): Promise<SandboxIdentity> => SandboxIdentitySchema.parse((await call(`GET`, `/s2s/identity`)).body);
    const me = async () => S2sMeSchema.parse((await call(`GET`, `/s2s/me`)).body);
    return { root, keysPath, txt, clock, rotations, identity, call, served, me };
};

test(`serves a document that verifies, makes its keys on first need in a 0600 file, and signs again only when a fact changes`, async () => {
    const { keysPath, clock, served } = setup();
    expect(existsSync(keysPath)).toBe(false);
    const first = await served();
    expect(verifyIdentity(first)).toEqual({ ok: true });
    expect(first).toMatchObject({ v: 1, sandbox: `0123456789ab`, name: `ops`, host: HOST, domains: [], protocols: [`s2s/1`], issuedAt: START });
    expect(Object.keys(first)).not.toContain(`prev`);
    expect(statSync(keysPath).mode & 0o777).toBe(0o600);
    clock.now += 60_000;
    expect(await served()).toEqual(first);
});

test(`answers the Identity section's view: the document as served, no domains, no recovery key, no earlier keys`, async () => {
    const { served, me } = setup();
    expect(await me()).toEqual({ document: await served(), domains: [], recovery: false, previousKeys: 0 });
});

test(`lists a claimed domain with the record to publish, and in the document only once its TXT record checks out`, async () => {
    const { txt, clock, call, served, me, identity } = setup();
    const fingerprint = (await served()).fingerprint;
    const claimed = await call(`POST`, `/s2s/me/domains`, { domain: ` Ops.Acme.Example ` });
    expect(claimed.status).toBe(200);
    expect(S2sMeSchema.parse(claimed.body).domains).toEqual([
        { domain: DOMAIN, verified: false, record: { name: `_intentic.${DOMAIN}`, value: `v=isk1 fp=${fingerprint} host=${HOST}` }, claimedAt: START },
    ]);
    expect((await served()).domains).toEqual([]);

    clock.now = START + 1_000;
    expect((await call(`POST`, `/s2s/me/domains/${DOMAIN}/check`)).status).toBe(200);
    expect((await me()).domains[0]).toMatchObject({ verified: false, checkedAt: START + 1_000, problem: `_intentic.${DOMAIN} has no record of ours yet` });

    txt.set(`_intentic.${DOMAIN}`, { kind: `records`, records: [[`v=isk1 fp=${fingerprint} host=${HOST}`]] });
    clock.now = START + 2_000;
    await call(`POST`, `/s2s/me/domains/${DOMAIN}/check`);
    expect((await me()).domains[0]).toEqual({
        domain: DOMAIN,
        verified: true,
        record: { name: `_intentic.${DOMAIN}`, value: `v=isk1 fp=${fingerprint} host=${HOST}` },
        claimedAt: START,
        checkedAt: START + 2_000,
    });
    const listed = await served();
    expect(listed.domains).toEqual([DOMAIN]);
    expect(listed.issuedAt).toBe(START + 2_000);
    expect(verifyIdentity(listed)).toEqual({ ok: true });
    expect(await identity.addresses()).toEqual([HOST, DOMAIN]);

    // The record taken down: the daily pass drops the domain again.
    txt.set(`_intentic.${DOMAIN}`, { kind: `records`, records: [[`v=isk1 fp=isk1:${`a`.repeat(52)} host=${HOST}`]] });
    await identity.checkDomains();
    expect((await served()).domains).toEqual([]);
    expect((await me()).domains[0]?.problem).toBe(`the record names key isk1:${`a`.repeat(52)}, not this sandbox's ${fingerprint}`);
});

test(`refuses what is no domain, a check or removal of one never claimed, and removes a claimed one`, async () => {
    const { call, me } = setup();
    expect(await call(`POST`, `/s2s/me/domains`, { domain: `ops.acme.example:8443` })).toEqual({
        status: 400,
        body: { error: `"ops.acme.example:8443" is no domain: give it as ops.example.com, without a port` },
    });
    expect((await call(`POST`, `/s2s/me/domains`, {})).status).toBe(400);
    expect(await call(`POST`, `/s2s/me/domains/${DOMAIN}/check`)).toEqual({ status: 404, body: { error: `${DOMAIN} is not claimed here` } });
    await call(`POST`, `/s2s/me/domains`, { domain: DOMAIN });
    expect((await call(`DELETE`, `/s2s/me/domains/${DOMAIN}`)).status).toBe(200);
    expect((await me()).domains).toEqual([]);
    expect((await call(`DELETE`, `/s2s/me/domains/${DOMAIN}`)).status).toBe(404);
});

test(`rotates to a key whose prev the old key signed, keeps the old one to open late arrivals, and tells the contacts module`, async () => {
    const { clock, call, served, me, rotations, identity } = setup();
    const before = await served();
    const oldKeys = await identity.current();
    const late = sealEnvelope({
        addressing: { from: `peer.example`, to: HOST, kind: `message`, hops: 0, sentAt: START },
        payload: { kind: `message`, text: `sealed before the rotation`, attachments: [] },
        sender: oldKeys,
        recipient: before.keys,
    });

    clock.now = START + 5_000;
    const rotated = S2sMeSchema.parse((await call(`POST`, `/s2s/me/rotate`)).body);
    const after = await served();
    expect(rotated.document).toEqual(after);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.prev).toMatchObject({ by: `key`, fingerprint: before.fingerprint, keys: before.keys, at: START + 5_000 });
    expect(verifyIdentity(after)).toEqual({ ok: true });
    expect(classifyIdentityChange({ pinned: { address: HOST, fingerprint: before.fingerprint }, next: after, address: HOST })).toEqual({ kind: `rotated` });
    expect(rotated.previousKeys).toBe(1);
    expect(rotations).toEqual([{ previous: before.fingerprint, document: after, by: `key` }]);

    const keys = await identity.openWith();
    expect(keys.map((set) => set.fingerprint)).toEqual([after.fingerprint, before.fingerprint]);
    expect(openEnvelope(late, { sender: oldKeys.public, keys })).toMatchObject({ ok: true, payload: { text: `sealed before the rotation` } });

    for (let turn = 0; turn < 4; turn++) {
        await call(`POST`, `/s2s/me/rotate`);
    }
    expect((await me()).previousKeys).toBe(3);
    expect((await identity.openWith()).map((set) => set.fingerprint)).not.toContain(before.fingerprint);
});

test(`shows a recovery key once, keeps only its public half, and brings the identity back on a sandbox that lost its volume`, async () => {
    const original = setup();
    const before = await original.served();
    const minted = await original.call(`POST`, `/s2s/me/recovery`);
    expect(minted.status).toBe(200);
    const { secret, fingerprint } = S2sRecoveryMintedSchema.parse(minted.body);
    expect(secret.startsWith(`isrs1.`)).toBe(true);
    const published = await original.served();
    expect(published.recovery).toBe(fingerprint);
    expect(verifyIdentity(published)).toEqual({ ok: true });
    expect((await original.me()).recovery).toBe(true);
    expect(JSON.stringify(await original.me())).not.toContain(secret.slice(`isrs1.`.length));
    expect(readFileSync(original.keysPath, `utf8`)).not.toContain(secret.slice(`isrs1.`.length));

    // The volume lost: a fresh sandbox with the same name and host, and only the pasted secret.
    const fresh = setup();
    fresh.clock.now = START + 86_400_000;
    const recovered = await fresh.call(`POST`, `/s2s/me/recover`, { secret: `  ${secret}\n` });
    expect(recovered.status).toBe(200);
    const after = await fresh.served();
    expect(after.prev).toMatchObject({ by: `recovery`, fingerprint, at: START + 86_400_000 });
    expect(after.recovery).toBe(fingerprint);
    expect(verifyIdentity(after)).toEqual({ ok: true });
    expect(classifyIdentityChange({ pinned: { address: HOST, fingerprint: before.fingerprint, recovery: fingerprint }, next: after, address: HOST })).toEqual({
        kind: `recovered`,
    });
    expect(fresh.rotations.map((rotation) => rotation.by)).toEqual([`recovery`]);
});

test(`refuses a recovery key that is not one, or not this sandbox's`, async () => {
    const one = setup();
    await one.call(`POST`, `/s2s/me/recovery`);
    const other = setup();
    const { secret } = S2sRecoveryMintedSchema.parse((await other.call(`POST`, `/s2s/me/recovery`)).body);
    expect(await one.call(`POST`, `/s2s/me/recover`, { secret: `hello` })).toEqual({ status: 400, body: { error: `that is no recovery key: one starts isrs1.` } });
    expect((await one.call(`POST`, `/s2s/me/recover`, { secret })).status).toBe(409);
    expect((await one.call(`POST`, `/s2s/me/recover`, {})).status).toBe(400);
    expect(one.rotations).toEqual([]);
});
