import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovedAction, IdentityReach, PublicRouteHandler } from "@intentic/extension-api";
import { resolveAddress } from "@intentic/sandbox-contract/s2s";
import { z } from "zod";
import { doorOf } from "../server/door.js";
import { testIdentity } from "../server/identity.testing.js";
import { LogStore } from "../server/log-store.js";
import { createPublisher, type Publisher } from "../server/publisher.js";
import { NetworkStore } from "../server/store.js";
import { DOOR_PREFIX, type PeerAnswer, type PeerNet } from "./net.js";
import { peerDoorOf } from "./peer-doors.js";
import { PeerStore } from "./peer-store.js";
import { syncPeer } from "./sync.js";

/* THREE SANDBOXES ON A FAKE NETWORK: A publishes, W witnesses, B follows A. B verifies A's log from A's doors alone, W
   cosigns each checkpoint only when it extends the last, a withdrawal reaches B's store, and when A serves a rewritten
   history signed with its own key, B holds it with both checkpoints as evidence and W refuses to cosign it. */

type Json = z.core.util.JSONType;
// Any value as the JSON a wire carries, checked: what a fake host answers.
const asJson = <T>(value: T): Json => z.json().parse(JSON.parse(JSON.stringify(value)));
const NOW = Date.parse(`2026-11-28T05:00:00Z`);

interface Node {
    readonly identity: IdentityReach & { readonly current: () => import("@intentic/sandbox-contract/schemas/s2s").SandboxIdentity };
    handler: PublicRouteHandler;
}

const answerOf = async (response: Response | undefined): Promise<PeerAnswer> => {
    if (response === undefined) {
        return { status: 404, body: undefined };
    }
    const text = await response.text();
    return { status: response.status, body: text === `` ? undefined : z.json().parse(JSON.parse(text)) };
};

const fakeNet = (nodes: ReadonlyMap<string, Node>): PeerNet => {
    const call = async (host: string, path: string, init: RequestInit): Promise<PeerAnswer> => {
        const node = nodes.get(host);
        if (node === undefined) {
            throw new Error(`${host} did not answer`);
        }
        if (path === `/s2s/identity`) {
            return { status: 200, body: asJson(node.identity.current()) };
        }
        const inside = path.startsWith(DOOR_PREFIX) ? path.slice(DOOR_PREFIX.length) : undefined;
        return inside === undefined ? { status: 404, body: undefined } : answerOf(await node.handler(new Request(`https://${host}${inside}`, init), { route: inside, at: NOW }));
    };
    return {
        resolve: (address) =>
            resolveAddress(address, {
                resolveTxt: async () => ({ kind: `missing` }),
                fetchIdentity: async (host) => {
                    const node = nodes.get(host);
                    return node === undefined ? { ok: false, error: `unreachable` } : { ok: true, body: asJson(node.identity.current()) };
                },
            }),
        get: (host, path) => call(host, path, { method: `GET` }),
        post: (host, path, body) => call(host, path, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) }),
    };
};

const dirs: string[] = [];
const freshDb = (): NetworkStore => {
    const dir = mkdtempSync(join(tmpdir(), `network-peer-`));
    dirs.push(dir);
    return new NetworkStore(join(dir, `network.sqlite`));
};
afterAll(() => {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A sandbox's log, published to through its own publisher, as the approvals queue would carry it out.
interface TestLog {
    readonly publisher: Publisher;
    readonly logs: LogStore;
    readonly door: PublicRouteHandler;
}
const logOf = (identity: IdentityReach): TestLog => {
    const store = freshDb();
    const logs = new LogStore(store.db);
    const publisher = createPublisher({ logs, identity, fileApproval: async () => undefined, cosignMode: async () => `offered`, authorName: async () => `A`, now: () => NOW });
    return { publisher, logs, door: doorOf({ logs, identity, keywords: async () => [], languages: async () => [] }) };
};

const approve = async (publisher: Publisher, draft: { readonly id: string; readonly digest: string }): Promise<void> => {
    const yes: ApprovedAction = { id: draft.id, digest: draft.digest, summary: ``, details: ``, approvedAt: NOW, actionRules: {} };
    expect(await publisher.perform(yes)).toMatchObject({ outcome: `done` });
};

const publishAll = async (publisher: Publisher, texts: readonly string[]): Promise<void> => {
    for (const text of texts) {
        await approve(publisher, await publisher.draftPublish({ text }));
    }
};

describe(`following another sandbox's log`, () => {
    it(`verifies, extends with a witness, carries withdrawals, and catches a rewritten history`, async () => {
        const aIdentity = testIdentity(`a.test`, `a`);
        const wIdentity = testIdentity(`w.test`, `w`);
        const a = logOf(aIdentity);
        const wStore = new PeerStore(freshDb().db);
        const nodes = new Map<string, Node>();
        const net = fakeNet(nodes);
        nodes.set(`a.test`, { identity: aIdentity, handler: a.door });
        nodes.set(`w.test`, {
            identity: wIdentity,
            handler: peerDoorOf({ peers: wStore, witness: { net, peers: wStore, identity: wIdentity, enabled: async () => true, now: () => NOW }, mirror: async () => false, guide: async () => false }),
        });

        const bStore = freshDb();
        const bPeers = new PeerStore(bStore.db);
        const source = bStore.add({ kind: `intentic`, address: `a.test` }, NOW);
        const deps = { net, peers: bPeers, witnesses: async () => [`w.test`], now: () => NOW };
        const signal = new AbortController().signal;

        // Nothing published yet: nothing read, nothing held.
        expect(await syncPeer(deps, source, signal)).toEqual({ items: [], withdrawn: [] });

        await publishAll(a.publisher, [`one`, `two`]);
        const first = await syncPeer(deps, source, signal);
        expect(first.items.map((item) => item.record.text)).toEqual([`one`, `two`]);
        expect(first.items[0]).toMatchObject({ nativeId: `a.test#0`, verification: `signature-valid`, verifiedBy: `intentic-log` });
        expect(bPeers.peer(source.id)).toMatchObject({ state: `ok`, size: 2, witnessed: [{ witness: `w.test`, size: 2 }] });

        await publishAll(a.publisher, [`three`]);
        await approve(a.publisher, await a.publisher.draftWithdraw(0));
        const second = await syncPeer(deps, source, signal);
        expect(second.items.map((item) => item.record.text)).toEqual([`three`]);
        expect(second.withdrawn).toEqual([`a.test#0`]);
        // The witness checked consistency from 2 to 4 against A's own proof before cosigning.
        expect(bPeers.peer(source.id)).toMatchObject({ state: `ok`, size: 4, witnessed: [{ witness: `w.test`, size: 4 }] });
        expect(bPeers.served(source.id, 0, 1)).toEqual([expect.objectContaining({ seq: 0, erased: true })]);

        // A now serves another history, signed with its own key: same keys, different first entries, longer.
        const forked = logOf(aIdentity);
        await publishAll(forked.publisher, [`ONE`, `TWO`, `three`, `four`, `five`]);
        nodes.set(`a.test`, { identity: aIdentity, handler: forked.door });
        expect(await syncPeer(deps, source, signal)).toEqual({ items: [], withdrawn: [] });
        const held = bPeers.peer(source.id);
        expect(held).toMatchObject({ state: `equivocation`, problem: `its entries do not hash to the root it signed: its history was rewritten` });
        expect(held?.evidence?.earlier.body).toContain(`\n4\n`);
        expect(held?.evidence?.later.body).toContain(`\n5\n`);

        // The witness refuses the forked checkpoint on its own: it does not extend what it cosigned.
        const asked = await net.post(`w.test`, `${DOOR_PREFIX}/witness/cosign`, { address: `a.test`, checkpoint: asJson(forked.logs.checkpoint()) }, signal);
        expect(asked).toMatchObject({ status: 409, body: { error: `this log does not extend the history this witness cosigned` } });

        // Held stays held until a person releases it.
        expect(await syncPeer(deps, source, signal)).toEqual({ items: [], withdrawn: [] });
    });

    it(`holds a peer whose key changed with no vouch from the old one`, async () => {
        const before = testIdentity(`c.test`, `c`);
        const after = testIdentity(`c.test`, `c`);
        const log = logOf(before);
        await publishAll(log.publisher, [`hello`]);
        const nodes = new Map<string, Node>([[`c.test`, { identity: before, handler: log.door }]]);
        const net = fakeNet(nodes);
        const store = freshDb();
        const peers = new PeerStore(store.db);
        const source = store.add({ kind: `intentic`, address: `c.test` }, NOW);
        const deps = { net, peers, witnesses: async () => [], now: () => NOW };
        expect((await syncPeer(deps, source, new AbortController().signal)).items).toHaveLength(1);
        nodes.set(`c.test`, { identity: after, handler: logOf(after).door });
        await syncPeer(deps, source, new AbortController().signal);
        expect(peers.peer(source.id)?.state).toBe(`held`);
    });
});
