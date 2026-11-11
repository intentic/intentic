import { demoRegistry } from "../../fixture/registry";
import {
    addCapability,
    capabilityList,
    capabilityStatus,
    dismissRecommendation,
    loginCapability,
    mintSshKey,
    probeCapability,
    remoteRefs,
    removeCapability,
    renameCapability,
    setCapabilitySecret,
} from "./capabilities";
import { type Doors, okAfter } from "../doors";
import { certificateRequest, deviceSignInStart, deviceSignInWait, mcpAuthCheck, mcpSignInStart, mcpSignInWait } from "./connectionSignIns";

// The connections, over the capability store (daemon/capabilities.ts): every write the Capabilities page sends changes
// what its next read says, and an add streams its apply.
export const capabilitiesDoors = {
    list: () => capabilityList(),
    status: ({ id }) => capabilityStatus(id),
    add: (capability) => addCapability(capability),
    probe: (capability) => probeCapability(capability),
    sshKey: () => mintSshKey(),
    remove: ({ id }) => okAfter(() => removeCapability(id)),
    rename: ({ id, to }) => okAfter(() => renameCapability(id, to)),
    setSecret: ({ id, value }) => okAfter(() => setCapabilitySecret(id, value)),
    // Every registry URL answers the same joined data; the real route would clone a repo and read two JSON files from it.
    marketplace: () => demoRegistry(),
    // Asked of no remote: each repository advertises a stable main, next and three release tags.
    refs: ({ url }) => remoteRefs(url),
    dismiss: ({ entry }) => okAfter(() => dismissRecommendation(entry)),
    login: ({ id }) => loginCapability(id),
    // A form's own sign-ins and key requests, answered with no provider behind them (connectionSignIns.ts).
    mcpAuth: ({ url }) => mcpAuthCheck(url),
    mcpSignIn: ({ url }) => mcpSignInStart(url),
    mcpSignInWait: ({ flow }) => mcpSignInWait(flow),
    deviceSignIn: () => deviceSignInStart(),
    deviceSignInWait: ({ flow }) => deviceSignInWait(flow),
    certificateRequest: (input) => certificateRequest(input),
} satisfies Doors<`capabilities`>;
