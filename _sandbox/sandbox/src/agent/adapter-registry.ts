import { type AgentHarness, type AgentProvider, capabilitiesOf } from "@intentic/sandbox-contract";
import { ACP_ADAPTER } from "../acp/acp-adapter.js";
import { PI_ADAPTER } from "../pi/pi-adapter.js";
import type { AgentAdapter } from "./adapter.js";
import { PROVIDER_ADAPTERS } from "./provider-registry.js";

/* RUNTIME → ADAPTER. The whole dispatch, in one table, so the question "which runtimes exist" has an answer a
 * reader can see — but the ROWS live with their providers now (each `<provider>-provider.ts`, aggregated by
 * agent/provider-registry.ts), so adding a runtime is a module in its provider's directory rather than an arm
 * grown onto this file. The two rows that are NOT a provider module's are appended here: ACP and Pi serve
 * installed capabilities, not native providers, and their adapters live beside their runtimes
 * (acp/acp-adapter.ts, pi/pi-adapter.ts).
 *
 * Keyed by RUNTIME rather than by provider, because that is what actually serves the turn: a `codex` provider
 * on the `claude-code` harness is served by the Claude Code loop pointed at the translator, and filing it under
 * a codex adapter would send it somewhere it never runs. `capabilitiesOf` already answers "which runtime" for
 * a (provider, harness) pair, and going through it here is what keeps the arm that serves a turn and the
 * abilities the rest of the daemon gates on reading the same row. */

/* LAZY, and it has to be: this module sits inside a genuine import cycle. The provider modules' arms call
 * shared turn machinery, turn-plan dispatches through adapterFor here, and this table is built FROM those
 * modules — so whichever module the entry point touches first, one of the others is still initializing when
 * it is reached. A top-level spread read the registry's binding before its module finished and crashed every
 * boot whose entry happened to start at a provider module. Function bodies run at CALL time, when every
 * module has long since initialized, so the table is assembled on first use and cached. */
let table: Map<AgentAdapter["runtime"], AgentAdapter> | undefined;
const byRuntime = (): Map<AgentAdapter["runtime"], AgentAdapter> =>
    (table ??= new Map([...PROVIDER_ADAPTERS, ACP_ADAPTER, PI_ADAPTER].map((adapter) => [adapter.runtime, adapter])));

// Every adapter, for the surfaces that iterate them (the health sweep, the registry's own test).
export const allAdapters = (): readonly AgentAdapter[] => [...byRuntime().values()];

/* The adapter serving a (provider, harness) pair. Total by construction: `runtime` is a closed union on the
 * contract's own record, and the table above covers it, adapter-registry.test.ts walks every pair and demands
 * one, the same guard agent-catalog.test.ts applies to the records themselves. */
export const adapterFor = (provider: AgentProvider, harness: AgentHarness): AgentAdapter =>
    byRuntime().get(capabilitiesOf(provider, harness).runtime) as AgentAdapter;
