import { join } from "node:path";
import type { CompositionCore } from "../composition.js";
import { defineSlice } from "../seams/slice.js";
import { type ConnectionHub, createConnectionHub } from "./connection-hub.js";
import { connectionHubDocument, fileHubStore } from "./hub-store.js";

// The connections hub (schemas/connection-hub.ts): the owner's computer's keyring as where their connections live,
// saved there from one sandbox and taken into another. Started with the keyrings (boot-schedulers.ts), since it reacts
// to what each keyring read brings.
export interface HubSlice {
    readonly connectionHub: ConnectionHub;
}

export const hubSlice = defineSlice<HubSlice>({
    build: ({ authRoot, logger, whole }: Pick<CompositionCore, "authRoot" | "logger" | "whole">) => ({
        connectionHub: createConnectionHub({ store: fileHubStore(join(authRoot, connectionHubDocument.path)), logger, whole }),
    }),
});
