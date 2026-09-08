import type { LoginStart, Model, NativeProvider, OauthAccount, SecretInventoryEntry, TranslatorAccounts } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { stateRelPath } from "../../workspace/layout/state-paths.js";
import type { Services } from "../../composition.js";
import type { AgentAdapter } from "./adapter.js";

// What a native provider owes the daemon, so shared surfaces (adapters, catalogs, readiness, boot, packs, secrets)
// iterate providers instead of each keeping its own list; each provider directory exports one module,
// provider-registry.ts aggregates them. Stays enumerated only where deriving would defeat the point:
// - the router's per-provider mounts (type-checked against the contract)
// - the route harness's test doubles (a claim about behaviour, not derivable)
// - the web app's surfaces (a different program; the contract is its registry)

// A provider's model catalog: models plus a default id, never empty, in the provider's own preference order.
export interface ProviderCatalog {
    readonly models: () => Promise<{ models: Model[]; default: string }>;
}

// Two facts main.ts resolves before boot: `roots` (this daemon owns the workspace-root state files) and `container` (it
// owns the container-wide furniture).
export interface BootRole {
    readonly container: boolean;
    readonly roots: boolean;
}

// Reads shared across provider modules per sweep, memoized so iterating them costs one round trip, not one per
// provider. Answerable even with no translator configured (falls back to on-disk auth files).
export interface SharedProviderReads {
    readonly translatorAccounts: () => Promise<TranslatorAccounts>;
}

// Connects, lists, renames and drops this provider's own accounts (not the translator's subscriptions), behind the one
// shape at /accounts/{provider}. Nothing redeemable crosses the seam: a start returns only a page and a handshake.
export interface AccountDoor {
    readonly start: (variant: string | undefined) => Promise<LoginStart>;
    // Finishes with the page's code or redirect; undefined if minting continues, absent if self-finishing.
    readonly complete?: (input: {
        readonly handshake: string;
        readonly code?: string | undefined;
        readonly redirectUrl?: string | undefined;
        readonly label?: string | undefined;
    }) => Promise<OauthAccount | undefined>;
    readonly cancel: (handshake: string) => void;
    // `force` re-measures the plan limits before answering, for the doors that have any to measure.
    readonly list: (force: boolean) => Promise<OauthAccount[]>;
    // Undefined means no such account (404): the row may have just been disconnected by another device.
    readonly rename: (id: string, label: string) => Promise<OauthAccount | undefined>;
    readonly disconnect: (id: string) => Promise<void>;
}

export interface ProviderModule {
    readonly id: NativeProvider;
    // Adapter rows this provider contributes; empty when another module's runtime serves it instead.
    readonly adapters: readonly AgentAdapter[];
    // This provider's catalog read; the registry projects it into the record every consumer reads.
    readonly catalog: (services: Services) => Promise<{ models: Model[]; default: string }>;
    // Whether a turn could be served now, from cheap facts only; never a probe that costs a turn.
    readonly ready: (services: Services, shared: SharedProviderReads) => Promise<boolean>;
    // Fire-and-forget and best-effort: a throw is logged, not a failed daemon. Absent means nothing to start.
    readonly boot?: (services: Services, role: BootRole, logger: Logger) => void;
    // Feature packs a connected account wants in the next rebuild, read from disk, not a live helper.
    readonly packs?: (services: Services) => Promise<readonly string[]>;
    // This provider's rows in the secrets inventory, one per connected account; absent means none stored.
    readonly secretEntries?: (services: Services, shared: SharedProviderReads) => Promise<SecretInventoryEntry[]>;
    // This provider's account door, built once per daemon; absent means /accounts/{provider} 404s for it.
    readonly accounts?: (services: Services) => AccountDoor;
}

// One connected account's row in the secrets inventory, in the shape that page renders.
export const providerAccountEntry = (provider: string, providerName: string, id: string, label: string, storedAt: string): SecretInventoryEntry => ({
    key: `${provider}:${id}`,
    kind: "provider",
    label: `${providerName} · ${label}`,
    status: "connected",
    requiredBy: [],
    storedAt,
    revealable: false,
});

// Auth tree every provider's credential lives under; uses the same helper the stores use so `storedAt` can't drift from
// the real path.
export const authStateRelPath = (...segments: string[]): string => stateRelPath(".intentic/secrets/auth/", ...segments);
