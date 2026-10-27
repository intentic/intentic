import { loopsOf, TRIAL_LABEL, TRIAL_PROVIDER } from "@intentic/sandbox-contract/models/agent-catalog";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { freshEdition, noModels } from "../../mode";
import { DEMO_CATALOGS } from "./accounts";
import type { Doors } from "../doors";

export const providersDoors = {
    // An unconnected provider answers empty, matching the real daemon's behavior.
    models: ({ provider }) => DEMO_CATALOGS[provider] ?? { models: [], default: `` },
    // The recorded workspace adds no ACP agent and no endpoint of its own, but the composer's gate waits on this read
    // as much as on the accounts above it.
    // The recording is a box with Claude connected, which is what its chats are addressed to; `native` is how a
    // reader who cannot open /accounts learns that.
    // Every loop the catalog offers, as a daemon of this build would advertise them.
    list: () => ({
        ...(freshEdition || noModels
            ? { native: [], agents: [], endpoints: noModels ? [] : [{ id: TRIAL_PROVIDER, label: TRIAL_LABEL, kind: `endpoint` as const }] }
            : { native: [`claude`], agents: [], endpoints: [] }),
        loops: Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, [...loopsOf(provider)]])),
    }),
} satisfies Doors<`providers`>;
