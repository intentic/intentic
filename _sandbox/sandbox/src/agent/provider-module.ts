import type { NativeProvider, SecretInventoryEntry, TranslatorAccounts, Model } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { stateRelPath } from "../workspace/state-paths.js";
import type { Services } from "../composition.js";
import type { AgentAdapter } from "./adapter.js";

/* WHAT A NATIVE PROVIDER OWES THE DAEMON, said once, so the shared surfaces can ITERATE providers instead of
 * each keeping its own hand-maintained list of them.
 *
 * It exists because adding Cursor touched eleven shared files, and one of them was missed: the secrets
 * inventory kept listing four providers' account rows while six were connectable, and nothing failed, because
 * the inventory was an enumeration and enumerations do not know what they are missing. That is the repo's own
 * rule ("guard invariants by discovery, not enumeration") violated in six separate places at once — the
 * adapter table, the catalog table, the readiness record, the boot blocks, the pack predicates, the secrets
 * rows — each a private list of the same six names.
 *
 * The module is the discovery unit. Each provider directory exports one; provider-registry.ts aggregates them;
 * the six consumers derive their answer from the aggregation. Adding a provider is then: the contract row (the
 * wire vocabulary, compiler-enforced), the provider directory with its module, and one import line in the
 * registry. A consumer a module forgets to serve fails the registry's own test rather than shipping silently.
 *
 * WHAT DELIBERATELY STAYS ENUMERATED, and why each:
 *   - the ROUTER's per-provider mounts: implement(sandboxContract) type-checks each mount against the contract,
 *     and that forcing function (a contract without an implementation does not compile) is worth one line.
 *   - route-testing's doubles: a test double is a claim about behaviour, and deriving claims would test the
 *     derivation.
 *   - the web app's surfaces: a different program on the other side of the wire; the contract is its registry.
 *
 * The methods take the full Services on purpose. A provider arm genuinely reads across the daemon (its own
 * slice, the workspace, the browser stack, the persona), and a narrowed parameter type per method would be six
 * hand-kept Pick<> lists that rot exactly the way the enumerations did. The type is imported type-only, so no
 * runtime cycle exists: composition imports the registry's values, modules import only composition's types. */

// A provider's model catalog: its models (+ default id), NEVER empty, in the provider's own preference order.
// The one question every provider answers identically, which is why it is the one method the record every
// consumer reads (services.providerCatalogs) is built from.
export interface ProviderCatalog {
    readonly models: () => Promise<{ models: Model[]; default: string }>;
}

// The two facts main.ts resolves about this daemon before anything boots, and the only ones a provider's boot
// tasks have ever branched on: `roots` = this daemon owns the workspace-root state files; `container` = it owns
// the container-wide furniture (sockets, watchers, spawned helpers).
export interface BootRole {
    readonly container: boolean;
    readonly roots: boolean;
}

/* Reads that several modules would otherwise repeat per sweep, handed in memoized so iterating six modules
 * costs the same round trips the hand-written code paid. The translator's account map is THE case: four
 * providers authenticate through it, and four independent management-API calls per readiness sweep is the
 * regression a derived list must not smuggle in.
 *
 * Always answerable, even with no translator configured: the client falls back to reading the auth files on
 * disk, which is exactly what the secrets inventory has always shown on such a sandbox. A READINESS rung that
 * must not even ask without a translator URL checks that gate itself, before touching this (see the codex
 * module) — the gate is the rung's fact, not the read's. */
export interface SharedProviderReads {
    readonly translatorAccounts: () => Promise<TranslatorAccounts>;
}

export interface ProviderModule {
    readonly id: NativeProvider;
    /* The adapter rows this provider's runtimes contribute (adapter-registry assembles them). Usually one;
     * EMPTY for a provider served entirely by another module's runtime — Kimi runs under the Claude Code loop,
     * so its module contributes no adapter and the registry's test asserts that absence is backed by
     * capabilitiesOf naming a runtime some other module provides. */
    readonly adapters: readonly AgentAdapter[];
    // This provider's catalog read, against the built services. The registry projects it into the
    // Record<NativeProvider, ProviderCatalog> every picker/route/validator reads.
    readonly catalog: (services: Services) => Promise<{ models: Model[]; default: string }>;
    // Whether a turn on this provider could be served right now: the harnessReadyProviders rung. Cheap facts
    // only (a store listing, a config string, the shared translator read) — never a probe that costs a turn.
    readonly ready: (services: Services, shared: SharedProviderReads) => Promise<boolean>;
    /* Boot tasks: config writes, gate sockets, refresh timers, warm-ups. Fire-and-forget and BEST-EFFORT by
     * contract: a boot that throws is the module's own log line, never a failed daemon. Absent ⇒ nothing to
     * start. */
    readonly boot?: (services: Services, role: BootRole, logger: Logger) => void;
    // The feature packs a CONNECTED account of this provider wants baked into the next rebuild, by pack name.
    // Read from disk, never from a live helper (see provider-packs.ts for why). Absent ⇒ none.
    readonly packs?: (services: Services) => Promise<readonly string[]>;
    // This provider's rows in the secrets inventory: one entry per connected account, saying where the
    // credential lives on disk. Absent ⇒ the provider stores nothing here (none today; absence is legal so a
    // future keyless provider does not have to fake an empty list).
    readonly secretEntries?: (services: Services, shared: SharedProviderReads) => Promise<SecretInventoryEntry[]>;
}

// One connected account's row in the secrets inventory, in the one shape that page renders. Moved here from
// secrets.routes.ts because the modules author the rows now and the route only concatenates them.
export const providerAccountEntry = (provider: string, providerName: string, id: string, label: string, storedAt: string): SecretInventoryEntry => ({
    key: `${provider}:${id}`,
    kind: "provider",
    label: `${providerName} · ${label}`,
    status: "connected",
    requiredBy: [],
    storedAt,
    revealable: false,
});

// The auth tree every provider's credential lives under, spelled through the same helper the stores use, so a
// module's `storedAt` and the store's actual path cannot drift.
export const authStateRelPath = (...segments: string[]): string => stateRelPath(".intentic/secrets/auth/", ...segments);
