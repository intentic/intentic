import type { Model, NativeProvider } from "@intentic/sandbox-contract";
import type { ClaudeCatalog } from "../claude/claude-models.js";
import type { CodexCatalog } from "../codex/codex-catalog.js";
import type { CursorCatalog } from "../cursor/cursor-catalog.js";
import type { GeminiCatalog } from "../gemini/gemini-catalog.js";
import type { OpenCodeService } from "../grok/opencode.js";
import type { KimiCatalog } from "../kimi/kimi-catalog.js";

/* PROVIDER → CATALOG. The whole set of "what can this provider run", in one table, the same discipline
 * adapter-registry.ts applies to serving a turn, applied to the other question every provider answers.
 *
 * It exists because three separate call sites had to fan back out over the providers to ask them all the
 * identical question, and each wrote its own chain to do it: the picker's route (five route factories, three of
 * them the same fifteen lines with a name swapped), the quick model's comparison (a five-arm ternary), and the
 * routed-turn model resolution (a four-arm if). Every one of them was a `switch` standing in for a lookup, and
 * each had to be edited to add a provider, so a sixth would have been a sixth vertical slice through the
 * contract, the router, the service container and every test double.
 *
 * WHAT A CATALOG OWES is deliberately one method. The per-provider implementations behind it are genuinely
 * different. Claude probes the Agent SDK, Codex and Gemini walk a discovery ladder down to a persisted floor,
 * Kimi reads the translator's provider definitions, Grok goes through OpenCode, and they keep their own
 * modules and their own extras (Codex's `record`, Claude's per-account probe). This is the seam they meet at,
 * not a replacement for any of them.
 *
 * NOT a fixed five. Endpoint capabilities also publish catalogs, and deliberately do NOT appear here: they are
 * user-created and unbounded, keyed by capability id, with no seed floor and a NOT_FOUND when the id names
 * nothing. Same shape, different question, see endpoints.routes.ts. */
export interface ProviderCatalog {
    // This provider's models (+ its default id), never empty. Order is the provider's own preference order.
    readonly models: () => Promise<{ models: Model[]; default: string }>;
}

export interface ProviderCatalogDeps {
    readonly claude: ClaudeCatalog;
    readonly codex: CodexCatalog;
    // Cursor's list is an ENTITLEMENT rather than a public catalog: two accounts on different plans see
    // different rows, so it is the only one here that cannot be read without a connected credential.
    readonly cursor: CursorCatalog;
    readonly gemini: GeminiCatalog;
    readonly kimi: KimiCatalog;
    // Grok's catalog is not a catalog service of its own: OpenCode owns the xAI credential and the discovery
    // that goes with it, so the table points at that service's own reader rather than wrapping it in a twin.
    readonly openCode: Pick<OpenCodeService, "xaiModels">;
}

// The table. Every entry is a thunk rather than the catalog object itself, which is what lets the one Grok row
// come off a service that is not shaped like the other four without a wrapper existing to make it look like it.
export const createProviderCatalogs = (deps: ProviderCatalogDeps): Record<NativeProvider, ProviderCatalog> => ({
    claude: { models: () => deps.claude.models() },
    codex: { models: () => deps.codex.models() },
    cursor: { models: () => deps.cursor.models() },
    grok: { models: () => deps.openCode.xaiModels() },
    kimi: { models: () => deps.kimi.models() },
    gemini: { models: () => deps.gemini.models() },
});
