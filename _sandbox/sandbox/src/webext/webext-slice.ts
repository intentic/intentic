import type { Capability, WebExtFacts, WebExtScopes } from "@intentic/sandbox-contract";
import { createPeerHub, type PeerDoorDeps } from "../peers/peer-hub.js";
import { filePeerStore } from "../peers/peer-store.js";
import {
    ownBrowserReach,
    type OwnBrowserReach,
    WEBEXT_PEER,
    type WebExtAnnounced,
    type WebExtClient,
    type WebExtHub,
    type WebExtStore,
} from "./webext-peer.js";

// The owner's browser extension: its door, hub and reach.
export interface WebextSlice {
    readonly webexts: WebExtStore;
    readonly webextHub: WebExtHub;
    // Which of the owner's own browsers a turn may work in, and what each of them is, for the same reason hostReach
    // exists: the prompt names the browser in front of the person without the agent importing the webext subsystem.
    readonly webextReach: (granted: readonly Capability[]) => Promise<OwnBrowserReach | undefined>;
}

// Builds the webext slice; its reach reads only the hub it builds, so nothing here waits on the rest of the daemon.
export const createWebextSlice = ({ historyRoot, logger, peerTools }: PeerDoorDeps): WebextSlice => {
    const webextHub = createPeerHub<WebExtClient, WebExtAnnounced, WebExtFacts, WebExtScopes>(WEBEXT_PEER.hub, logger, peerTools);
    return {
        webexts: filePeerStore(historyRoot, WEBEXT_PEER.store),
        webextHub,
        // Held readings only (webext/webext-peer.ts), like hostReach: a browser that is closed costs the turn nothing.
        webextReach: (granted) => ownBrowserReach({ webextHub }, granted),
    };
};
