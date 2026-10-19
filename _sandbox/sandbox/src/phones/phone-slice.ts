import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { PhoneFacts, PhoneScopes } from "@intentic/sandbox-contract/schemas/phone";
import type { CompositionCore } from "../composition.js";
import { createPeerHub, type PeerDoorDeps } from "../peers/peer-hub.js";
import { defineSlice } from "../seams/slice.js";
import { filePeerStore } from "../peers/peer-store.js";
import {
    ownPhoneReach,
    type OwnPhoneReach,
    PHONE_PEER,
    type PhoneAnnounced,
    type PhoneClient,
    type PhoneHub,
    type PhoneStore,
} from "./phone-peer.js";
import { filePhonePairings, type PhonePairings } from "./phone-pairings.js";
import { filePhoneWake, type PhoneWake } from "./phone-wake.js";

// The owner's phones: their door, hub, wake channels and reach.
export interface PhonesSlice {
    readonly phones: PhoneStore;
    readonly phoneHub: PhoneHub;
    readonly phoneWake: PhoneWake;
    // Which computers' keyrings each phone paired with for Passwords (phone-passwords.routes.ts).
    readonly phonePairings: PhonePairings;
    // Which of the owner's phones a turn may work on, for the prompt, without the agent importing this subsystem.
    readonly phoneReach: (granted: readonly Capability[]) => Promise<OwnPhoneReach | undefined>;
}

const createPhonesSlice = ({ historyRoot, logger, peerTools }: PeerDoorDeps): PhonesSlice => {
    const phoneHub = createPeerHub<PhoneClient, PhoneAnnounced, PhoneFacts, PhoneScopes>(PHONE_PEER.hub, logger, peerTools);
    return {
        phones: filePeerStore(historyRoot, PHONE_PEER.store),
        phoneHub,
        phoneWake: filePhoneWake(historyRoot, logger),
        phonePairings: filePhonePairings(historyRoot),
        // Held readings only, like hostReach and webextReach: a phone asleep in a pocket costs the turn nothing.
        phoneReach: (granted) => ownPhoneReach({ phoneHub }, granted),
    };
};

export const phonesSlice = defineSlice<PhonesSlice>({
    build: ({ config, logger, peerTools }: Pick<CompositionCore, "config" | "logger" | "peerTools">) =>
        createPhonesSlice({ historyRoot: config.historyRoot, logger, peerTools }),
});
