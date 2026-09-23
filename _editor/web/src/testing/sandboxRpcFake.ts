import { unstubbed } from "@intentic/testing";
import type { SandboxRpc } from "../features/sandbox/client/sandboxRpc";

// The one fake of the typed daemon client, for every suite; type-checked with them, never bundled (nothing the app loads
// imports it).

// What a suite answers for, per contract group: the procedures its code under test calls, typed as the client has them.
export type SandboxRpcStubs = { readonly [G in keyof SandboxRpc]?: Partial<SandboxRpc[G]> };

// The typed daemon client a suite installs over sandboxRpc's: a stubbed procedure answers as stubbed, and any other
// throws naming itself (`sandboxRpc.git.log was called…`), so a call the suite did not expect says which one it was.
export const fakeSandboxRpc = (stubs: SandboxRpcStubs = {}): SandboxRpc =>
    unstubbed<SandboxRpc>(
        `sandboxRpc`,
        Object.fromEntries(Object.entries(stubs).map(([group, procedures]) => [group, unstubbed(`sandboxRpc.${group}`, procedures ?? {})])),
    );
