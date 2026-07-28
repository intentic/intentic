import { type SecretInventoryEntry, SecretInventorySchema, SecretKeysSchema, SecretRevealSchema } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { devFillSet } from "../devFill";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* User-supplied env-var secrets (Cloudflare token, GitHub PAT, another-host SSH key), written straight to the
 * sandbox daemon's /secrets routes (never through the platform). Split by consumer so a surface only observes
 * the server state it reads (an observer mount refetches its query, so bundling made every SecretEntryRow
 * refire both): `useSecretKeys` is the KEYS-ONLY list (hasKey checks in credential forms), `useSecretInventory`
 * the unified view (env + generated + capabilities + AI providers, with status/provenance/CI state, never
 * values), `useMissingSecretCount` that same inventory reduced to the one number the always-mounted chrome
 * shows, `useSecrets` the mutations; `reveal` is the single value-returning call — owner-only, and
 * deliberately NOT a query so a secret value never enters the query cache or its IndexedDB persistence. */

// Owner-only; a member gets the daemon's 403 message as a thrown Error. Plain async on purpose (no cache).
export const reveal = async (key: string): Promise<string> =>
    SecretRevealSchema.parse(
        await sandboxJson(`/secrets/reveal`, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify({ key }) }),
    ).value;

export function useSecretKeys() {
    const { query } = useSandboxQuery({
        queryKey: sandboxKey(`secrets`),
        // 412 until DevOps is active — treat as "no keys yet" rather than surfacing an error.
        queryFn: async (): Promise<string[]> => {
            try {
                return SecretKeysSchema.parse(await sandboxJson(`/secrets`)).keys;
            } catch {
                return [];
            }
        },
    });
    return {
        keys: computed<string[]>(() => query.data.value ?? []),
        hasKey: (key: string): boolean => (query.data.value ?? []).includes(key),
    };
}

const fetchInventory = async (): Promise<SecretInventoryEntry[]> => SecretInventorySchema.parse(await sandboxJson(`/secrets/inventory`)).entries;

// The one definition of "missing" every surface shouts about: a secret the INTENT declares that the sandbox
// does not have. Generated values (the first deploy produces them) and capability/provider entries are not the
// user's to set, so an unset one is not an outstanding task — counting those would make the chrome cry wolf.
const missingRequired = (entries: readonly SecretInventoryEntry[]): number =>
    entries.filter((entry) => entry.kind === `env` && entry.requiredBy.length > 0 && entry.status === `missing`).length;

export function useSecretInventory() {
    const queryClient = useQueryClient();
    const inventoryKey = sandboxKey(`secrets`, `inventory`);
    const { query } = useSandboxQuery({ queryKey: inventoryKey, queryFn: fetchInventory });
    const inventory = computed<SecretInventoryEntry[]>(() => query.data.value ?? []);
    return {
        inventory,
        missingRequiredCount: computed(() => missingRequired(inventory.value)),
        // isPending, not isLoading: true from mount until the FIRST data (even while `reachable` still gates the
        // fetch), so the page shows its reading placeholder instead of fake empty states during the handshake.
        inventoryPending: computed(() => query.isPending.value),
        refreshInventory: (): void => void queryClient.invalidateQueries({ queryKey: inventoryKey }),
    };
}

// Just the attention count, for the AMBIENT chrome — the rail's sandbox chip, the mobile menu row, the sandbox
// overview — which is mounted app-wide rather than on a secrets surface. Same query, deliberately different
// observer options: /secrets/inventory is a fan-out (a digest per secret over the desired-state repo, the
// capability list, the connector registry, an HTTP call to the cliproxy's account API), and the client's
// default freshness is staleTime 0 + refetch-on-focus — so a permanently mounted observer would re-run that
// aggregate on every window focus of every page, for every user, secrets surface open or not. Every write
// invalidates the key (useSecrets below), so the badge still moves the instant a value is set; only the
// ambient POLLING is dropped. Kept a separate hook, not an option on the one above, for the same reason the
// keys/inventory/mutations split exists at all: a surface observes only the server state it actually reads.
const AMBIENT_STALE_MS = 5 * 60 * 1000;
export function useMissingSecretCount() {
    const { query } = useSandboxQuery({
        queryKey: sandboxKey(`secrets`, `inventory`),
        queryFn: fetchInventory,
        staleTime: AMBIENT_STALE_MS,
        refetchOnWindowFocus: false,
    });
    return {
        missingRequiredCount: computed(() => missingRequired(query.data.value ?? [])),
        countPending: computed(() => query.isPending.value),
    };
}

export function useSecrets() {
    const queryClient = useQueryClient();

    const invalidate = (): void => {
        void queryClient.invalidateQueries({ queryKey: sandboxKey(`secrets`) });
        void queryClient.invalidateQueries({ queryKey: sandboxKey(`secrets`, `inventory`) });
    };

    const set = useMutation({
        mutationFn: (input: { key: string; value: string }) =>
            sandboxJson(`/secrets`, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(input) }),
        // Every .env secret write funnels through here, so this one hook feeds the dev autofill for all of them.
        onSuccess: (_data, input) => {
            invalidate();
            devFillSet(`secret.${input.key}`, input.value);
        },
    });

    const remove = useMutation({
        mutationFn: (key: string) => sandboxJson(`/secrets/${encodeURIComponent(key)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });

    return { set, remove };
}
