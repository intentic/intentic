import { type AgentHarness, type AgentProvider, capabilitiesOf } from "@intentic/sandbox-contract";
import { ACP_ADAPTER } from "../../runtimes/acp/acp-adapter.js";
import { PI_ADAPTER } from "../../runtimes/pi/pi-adapter.js";
import type { AgentAdapter } from "./adapter.js";
import { PROVIDER_ADAPTERS } from "./provider-registry.js";

// Runtime → adapter dispatch table. Provider rows live with their providers (`<provider>-provider.ts`, aggregated by
// provider-registry.ts); ACP and Pi are appended here since they serve installed capabilities, not native providers.
// Keyed by runtime, not provider, since that's what actually serves a turn — capabilitiesOf resolves which runtime a
// (provider, harness) pair uses.

// Lazy on purpose: this module sits inside a genuine import cycle with the provider modules, so a top-level read of the
// registry could run before they finish initializing. Assembled on first call instead, then cached.
let table: Map<AgentAdapter["runtime"], AgentAdapter> | undefined;
const byRuntime = (): Map<AgentAdapter["runtime"], AgentAdapter> =>
    (table ??= new Map([...PROVIDER_ADAPTERS, ACP_ADAPTER, PI_ADAPTER].map((adapter) => [adapter.runtime, adapter])));

// Every adapter, for the surfaces that iterate them (the health sweep, the registry's own test).
export const allAdapters = (): readonly AgentAdapter[] => [...byRuntime().values()];

// The adapter for a (provider, harness) pair; total by construction since `runtime` is a closed union the table covers.
// adapter-registry.test.ts walks every pair and demands one, mirroring agent-catalog.test.ts's guard on the records.
export const adapterFor = (provider: AgentProvider, harness: AgentHarness): AgentAdapter =>
    byRuntime().get(capabilitiesOf(provider, harness).runtime) as AgentAdapter;
