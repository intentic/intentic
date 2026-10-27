import {
    cancelNativeSignIn,
    completeNativeSignIn,
    disconnectNativeAccount,
    nativeAccounts,
    nativeSignInStatus,
    renameNativeAccount,
    startNativeSignIn,
} from "./signIns";
import { type Doors, okAfter } from "../doors";

// The sandbox's own accounts, over the sign-in store (daemon/signIns.ts): a fresh sandbox starts with none, every other
// recording with two Claude subscriptions, and a sign-in started here lands in the list the way the real one does. The
// path is the daemon's own `/accounts/{provider}` (provider-module.ts); while it was `/{provider}/accounts` here every
// read 404'd, `accountsLoaded` never flipped, and the Agent tab drew skeleton rows for as long as it was open.
export const accountsDoors = {
    accounts: ({ provider }) => ({ accounts: nativeAccounts(provider) }),
    start: ({ provider, variant }) => startNativeSignIn(provider, variant),
    status: ({ handshake }) => nativeSignInStatus(handshake),
    complete: (input) => completeNativeSignIn(input),
    cancel: ({ handshake }) => okAfter(() => cancelNativeSignIn(handshake)),
    rename: ({ provider, id, label }) => renameNativeAccount(provider, id, label),
    disconnect: ({ provider, id }) => okAfter(() => disconnectNativeAccount(provider, id)),
} satisfies Doors<`accounts`>;
