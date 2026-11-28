import { join } from "node:path";
import type { ExtensionServerApi, ServerActivation } from "@intentic/extension-api";
import type { Source } from "../wire.js";
import { startCurator } from "./curator.js";
import { doorOf } from "./door.js";
import { LogStore } from "./log-store.js";
import { createPoller, settingsOf } from "./poller.js";
import { createPublisher } from "./publisher.js";
import { createPeerNet } from "../peers/net.js";
import { peerDoorOf } from "../peers/peer-doors.js";
import { PeerStore } from "../peers/peer-store.js";
import { discover, peerViewOf } from "../peers/peer-view.js";
import { syncPeer } from "../peers/sync.js";
import { routesOf } from "./routes.js";
import { createService } from "./service.js";
import { NetworkStore } from "./store.js";
import { toolsOf } from "./tools.js";
import { createTransport } from "./transport.js";

/* THE BACKEND'S ACTIVATION (dist/server.js, run by the daemon's extension host): opens the store in the extension's own
   state directory, serves the view under /x/<id>, the agent's tools, and the `poll` handler the "Read Network sources"
   automation fires. Nothing is read until the owner adds a source; nothing is read on a schedule until they switch the
   automation on. */

export const DATABASE_FILE = `network.sqlite`;

export const activateServer = (api: ExtensionServerApi): ServerActivation => {
    const store = new NetworkStore(join(api.stateDir, DATABASE_FILE));
    const settings = async () => settingsOf(await api.settings.get());
    const list = (text: string): readonly string[] => text.split(/[\s,]+/u).map((word) => word.trim()).filter((word) => word !== ``);
    const peers = new PeerStore(store.db);
    const net = createPeerNet();
    const peerRead = (source: Source, signal: AbortSignal) => syncPeer({ net, peers, witnesses: async () => list((await settings()).witnesses), now: Date.now }, source, signal);
    const poller = createPoller(store, createTransport(), settings, Date.now, peerRead);
    const logs = new LogStore(store.db);
    const publisher = createPublisher({
        logs,
        identity: api.identity,
        fileApproval: async (item) => {
            await api.daemon.rpc.approvals.upsert(item);
        },
        cosignMode: async () => ((await settings()).requirePasskey ? `required` : `offered`),
        authorName: async () => (await settings()).authorName || (await api.identity.document()).name,
        now: Date.now,
    });
    const service = createService({
        store,
        poller,
        publisher,
        peers: {
            views: (current) => peers.peers().map((peer) => peerViewOf(peer, { now: Date.now(), trustedIssuers: current.trustedIssuers, witnesses: current.witnesses, verified: peer.size })),
            release: (sourceId) => peers.release(sourceId),
            discover: (current, query, signal) => discover(net, current.guides, query, signal),
        },
        settings,
        startCurator: (current, caller) => startCurator(api.daemon, current, caller),
        now: Date.now,
        log: api.log,
    });
    api.routes.mount(routesOf(service, (request) => api.caller(request)));
    api.tools.serve(() => toolsOf(service));
    api.approvals.perform((action) => publisher.perform(action));
    const logDoor = doorOf({ logs, identity: api.identity, keywords: async () => list((await settings()).catalogKeywords), languages: async () => list((await settings()).catalogLanguages) });
    const peerDoor = peerDoorOf({
        peers,
        witness: { net, peers, identity: api.identity, enabled: async () => (await settings()).witnessMode, now: Date.now },
        mirror: async () => (await settings()).mirrorMode,
        guide: async () => (await settings()).guideMode,
    });
    api.publicRoutes.serve(async (request, verified) => (await logDoor(request, verified)) ?? peerDoor(request, verified));
    const fires = api.automations.onFire(`poll`, (_fire, { signal }) => service.poll(signal));
    return {
        deactivate: async () => {
            fires.dispose();
            await poller.stop();
            store.close();
        },
        health: () => {
            const failing = store.sources().filter((source) => source.enabled && source.failures >= 3);
            return failing.length === 0
                ? { state: `ok` }
                : { state: `degraded`, detail: `${failing.length} source${failing.length === 1 ? `` : `s`} failing: ${failing.map((source) => source.label).join(`, `)}` };
        },
    };
};
