import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { WebExtFacts, WebExtScopes } from "@intentic/sandbox-contract/schemas/webext";
import type { CompositionCore } from "../composition.js";
import { createPeerHub, type PeerDoorDeps } from "../peers/peer-hub.js";
import { defineSlice } from "../seams/slice.js";
import { filePeerStore } from "../peers/peer-store.js";
import { createSecretTickets, type SecretTicketDesk } from "./secret-tickets.js";
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
    // A stored secret typed into one of those browsers without the agent seeing it: `typeIn` for the turn's tool, and
    // the half the browser's own door redeems its ticket through (secret-tickets.ts).
    readonly secretTickets: SecretTicketDesk;
}

// Builds the webext slice; its reach reads only the hub it builds, so nothing here waits on the rest of the daemon.
const createWebextSlice = ({ historyRoot, logger, peerTools }: PeerDoorDeps): WebextSlice => {
    const webextHub = createPeerHub<WebExtClient, WebExtAnnounced, WebExtFacts, WebExtScopes>(WEBEXT_PEER.hub, logger, peerTools);
    return {
        webexts: filePeerStore(historyRoot, WEBEXT_PEER.store),
        webextHub,
        // Held readings only (webext/webext-peer.ts), like hostReach: a browser that is closed costs the turn nothing.
        webextReach: (granted) => ownBrowserReach({ webextHub }, granted),
        // Approval cards included, a typing waits as long as any other call to the browser may.
        secretTickets: createSecretTickets({ hub: webextHub, callTimeoutMs: WEBEXT_PEER.hub.callTimeoutMs }),
    };
};

export const webextSlice = defineSlice<WebextSlice>({
    build: ({ config, logger, peerTools }: Pick<CompositionCore, "config" | "logger" | "peerTools">) =>
        createWebextSlice({ historyRoot: config.historyRoot, logger, peerTools }),
});
