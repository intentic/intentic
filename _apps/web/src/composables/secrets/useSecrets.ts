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
 * values), `useSecrets` the mutations; `reveal` is the single value-returning call — owner-only, and
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

export function useSecretInventory() {
    const queryClient = useQueryClient();
    const inventoryKey = sandboxKey(`secrets`, `inventory`);
    const { query } = useSandboxQuery({
        queryKey: inventoryKey,
        queryFn: async (): Promise<SecretInventoryEntry[]> => SecretInventorySchema.parse(await sandboxJson(`/secrets/inventory`)).entries,
    });
    return {
        inventory: computed<SecretInventoryEntry[]>(() => query.data.value ?? []),
        // isPending, not isLoading: true from mount until the FIRST data (even while `reachable` still gates the
        // fetch), so the page shows its reading placeholder instead of fake empty states during the handshake.
        inventoryPending: computed(() => query.isPending.value),
        refreshInventory: (): void => void queryClient.invalidateQueries({ queryKey: inventoryKey }),
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
