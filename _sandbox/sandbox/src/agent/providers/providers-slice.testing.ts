import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { SliceFakeContext } from "../../harness/slice-fake.testing.js";
import { PROVIDER_MODULES, RUNTIME_ADAPTERS } from "../../runtimes/runtime-table.js";
import { providerReadiness } from "./provider-registry.js";
import type { ProvidersSlice } from "./providers-slice.js";

// The providers slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// Never-empty catalog fakes so a native turn always resolves a model; spread this and replace one row to test a single
// provider differently. Enumerated, not derived, since a double is a claim about behaviour, not a derivation.
export const testProviderCatalogs: ProvidersSlice["providerCatalogs"] = {
    claude: { models: async () => ({ models: [{ id: "opus", label: "Opus" }], default: "opus" }) },
    codex: { models: async () => ({ models: [{ id: "gpt-5.1", label: "GPT 5.1" }], default: "gpt-5.1" }) },
    cursor: { models: async () => ({ models: [{ id: "auto", label: "Auto" }], default: "auto" }) },
    grok: { models: async () => ({ models: [{ id: "grok-4", label: "Grok 4" }], default: "grok-4" }) },
    kimi: { models: async () => ({ models: [{ id: "kimi-k3", label: "Kimi K3" }], default: "kimi-k3" }) },
    gemini: { models: async () => ({ models: [{ id: "gemini-pro-agent", label: "Gemini Pro Agent" }], default: "gemini-pro-agent" }) },
    meta: { models: async () => ({ models: [{ id: "muse-spark-1.2", label: "Muse Spark 1.2" }], default: "muse-spark-1.2" }) },
    zai: { models: async () => ({ models: [{ id: "glm-5.3", label: "GLM-5.3" }], default: "glm-5.3" }) },
};

// `usage` and `cliProxy` are too wide to spell out, so a suite passes the members it means and the rest self-name.
export interface ProvidersFakeOverrides {
    readonly usage?: Partial<ProvidersSlice["usage"]> | undefined;
    readonly cliProxy?: Partial<ProvidersSlice["cliProxy"]> | undefined;
}

export const providersSliceFake = (context: SliceFakeContext, { usage, cliProxy }: ProvidersFakeOverrides) =>
    ({
        usage: unstubbed("usage", { record: async () => {}, rollup: async () => [], turns: async () => [], ...usage }),
        // No usage measured by default, as if the window just reset.
        accountUsage: { read: async () => ({}), record: async () => {}, markUnread: async () => undefined, clear: async () => {} },
        // Nothing to sweep: reading one needs a live OAuth endpoint; writes are swallowed like the store's.
        headroom: {
            refresh: async () => {},
            held: () => [],
            parked: async () => false,
            park: async () => {},
            record: async () => {},
            clear: async () => {},
            read: async () => ({}),
            onChange: () => () => {},
            start: () => () => {},
        },
        // Nothing refused yet; both writes sit on the turn path, so any turn-running test touches this store.
        providerRefusals: { read: async () => ({}), record: async () => {}, clear: async () => {}, onChange: () => () => {} },
        // Nothing cooling; the write sits on the routed rate-limit path, so any refused routed turn touches this store.
        modelCooldowns: { cooling: async () => new Map(), record: async () => {} },
        // Nothing connected in the translator by default; the Codex subscription suite overrides this.
        cliProxy: unstubbed("cliProxy", {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }),
            connect: async () => ({ url: "", code: "", state: "", flow: "device" as const }),
            complete: async () => {},
            disconnect: async () => {},
            models: async () => [],
            headroom: { targets: async () => [] },
            sharedUsageKey: async () => undefined,
            turnLimit: async () => ({ spent: 0, withHeadroom: 0 }),
            // Nothing connected, so nothing to take out of the rotation; the account list calls this on every read.
            benchUnusable: async () => [],
            ...cliProxy,
        }),
        providerCatalogs: testProviderCatalogs,
        // The real tables: which runtime a pair reaches and which module answers for a provider are facts about the
        // product, not stand-ins. Readiness is swept through the finished services, so it asks this suite's stores.
        providerModules: PROVIDER_MODULES,
        adapters: RUNTIME_ADAPTERS,
        providerReadiness: () => providerReadiness(context.self()),
        async *agent() {
            yield { kind: "done" };
        },
        openCode: {
            client: async () => ({}) as never,
            stop: async () => {},
            events: async () => ({ stream: { async *[Symbol.asyncIterator]() {} } }),
            watch: async () => {},

            connected: async () => false,
            sessionExists: async () => true,
            xaiModels: async () => ({ models: [{ id: "grok-4", label: "Grok 4" }], default: "grok-4" }),
            recordModels: async () => {},
            disconnect: async () => {},
        },
        authRoot: `${WORKSPACE_ROOT}/${STATE_DIR}`,
    }) satisfies Partial<ProvidersSlice>;
