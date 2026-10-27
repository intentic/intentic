import { completeRouted, connectRouted, disconnectRouted, routedAccounts, routedStatus } from "./signIns";
import { type Doors, okAfter } from "../doors";

// The subscriptions connected through the translator, over the sign-in store (daemon/signIns.ts). Codex, Grok and Kimi
// sign in with a device code that is "approved" a few seconds after it shows; Google redirects to a loopback the sandbox
// can't receive, so its landing address is pasted back, as on a real sandbox with no machine of the owner's watching.
export const translatorDoors = {
    accounts: () => routedAccounts(),
    connect: ({ provider }) => connectRouted(provider),
    status: ({ state }) => routedStatus(state),
    complete: ({ state, redirectUrl }) => okAfter(() => completeRouted(state, redirectUrl)),
    disconnect: ({ provider, name }) => okAfter(() => disconnectRouted(provider, name)),
} satisfies Doors<`translator`>;
