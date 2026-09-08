import {
    type CredentialGate,
    CredentialGatesSchema,
    type SecretInventoryEntry,
    SecretInventorySchema,
    SecretKeysSchema,
    SecretRevealSchema,
} from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { devFillSet } from "../../setup/devFill";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { SANDBOX_MEMBERS, SECRET_GATES, SECRETS, SECRETS_INVENTORY } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { useSandboxSession } from "../../sandbox/client/sandboxSession";

// User-supplied env-var secrets, written straight to the daemon's /secrets routes, split by consumer so each
// surface only observes the server state it reads (an observer mount refetches its query). `reveal` is owner-only
// and deliberately not a query, so a value never enters the cache.

// Owner-only; a member gets the daemon's 403 message as a thrown Error. Plain async on purpose (no cache).
export const reveal = async (key: string): Promise<string> =>
    SecretRevealSchema.parse(await sandboxJson(`/secrets/reveal`, jsonBody(`POST`, { key }))).value;

export function useSecretKeys() {
    const { query } = useSandboxQuery({
        queryKey: SECRETS.of(),
        // 412 until DevOps is active, treat as "no keys yet" rather than surfacing an error.
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

// "Missing" means a secret the intent declares that the sandbox lacks; generated and capability/provider entries
// aren't the user's to set, so they don't count.
const missingRequired = (entries: readonly SecretInventoryEntry[]): number =>
    entries.filter((entry) => entry.kind === `env` && entry.requiredBy.length > 0 && entry.status === `missing`).length;

export function useSecretInventory() {
    const queryClient = useQueryClient();
    const inventoryKey = SECRETS_INVENTORY.of();
    const { query } = useSandboxQuery({ queryKey: inventoryKey, queryFn: fetchInventory });
    const inventory = computed<SecretInventoryEntry[]>(() => query.data.value ?? []);
    return {
        inventory,
        missingRequiredCount: computed(() => missingRequired(inventory.value)),
        // isPending, not isLoading: true until the first data lands, so the page shows a reading placeholder instead of
        // a
        // fake empty state.
        inventoryPending: computed(() => query.isPending.value),
        refreshInventory: (): void => void queryClient.invalidateQueries({ queryKey: inventoryKey }),
    };
}

// Attention count for app-wide chrome, mounted regardless of whether a secrets surface is open. Same query as the
// inventory but with its own staleTime/no-refetch-on-focus, since /secrets/inventory is an expensive fan-out that a
// permanently mounted observer would otherwise re-run on every window focus. Writes still invalidate it, so the
// badge updates immediately; only ambient polling is skipped.
const AMBIENT_STALE_MS = 5 * 60 * 1000;
export function useMissingSecretCount() {
    const { query } = useSandboxQuery({
        queryKey: SECRETS_INVENTORY.of(),
        queryFn: fetchInventory,
        staleTime: AMBIENT_STALE_MS,
        refetchOnWindowFocus: false,
    });
    return {
        missingRequiredCount: computed(() => missingRequired(query.data.value ?? [])),
        countPending: computed(() => query.isPending.value),
    };
}

// Who may release what, and who could be named: the approval editor needs both, so one hook covers policy
// (`/secrets/gates`) and roster (`/members`). Only the owner may write (enforced by the daemon); `isOwner` just
// renders the editor read-only instead of offering controls that would 403.
export function useCredentialGates() {
    const queryClient = useQueryClient();
    const gatesKey = SECRET_GATES.of();
    const { query: gatesQuery } = useSandboxQuery({
        queryKey: gatesKey,
        // An unwritten policy answers an empty list; anything else is a real error, surfaced rather than drawing a
        // sandbox
        // with no gates.
        queryFn: async (): Promise<CredentialGate[]> => CredentialGatesSchema.parse(await sandboxJson(`/secrets/gates`)).gates,
    });
    const { query: rosterQuery } = useSandboxQuery({
        queryKey: SANDBOX_MEMBERS.of(),
        queryFn: async (): Promise<{ members: { email: string }[]; owner?: string }> =>
            (await sandboxJson(`/members`)) as { members: { email: string }[]; owner?: string },
    });
    const { presentedEmail } = useSandboxSession();
    const invalidate = (): void => void queryClient.invalidateQueries({ queryKey: gatesKey });
    const setGate = useMutation({
        mutationFn: (gate: CredentialGate) => sandboxJson(`/secrets/gates/${encodeURIComponent(gate.subject)}`, jsonBody(`PUT`, gate)),
        onSuccess: invalidate,
    });
    const removeGate = useMutation({
        mutationFn: (subject: string) => sandboxJson(`/secrets/gates/${encodeURIComponent(subject)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });
    const owner = computed<string | undefined>(() => rosterQuery.data.value?.owner);
    return {
        gates: computed<CredentialGate[]>(() => gatesQuery.data.value ?? []),
        gateFor: (subject: string): CredentialGate | undefined => (gatesQuery.data.value ?? []).find((gate) => gate.subject === subject),
        // Owner first (the answer people reach for most), then the roster alphabetically; deduplicated since an owner
        // also
        // on the members file must not appear twice.
        approverChoices: computed<string[]>(() => {
            const roster = rosterQuery.data.value;
            return [...new Set([...(roster?.owner === undefined ? [] : [roster.owner]), ...(roster?.members ?? []).map((member) => member.email)])];
        }),
        // Compared lowercased: the roster normalizes on write, but a Google claim may preserve case.
        isOwner: computed<boolean>(() => {
            const me = presentedEmail.value?.toLowerCase();
            return me !== undefined && owner.value?.toLowerCase() === me;
        }),
        setGate,
        removeGate,
    };
}

export function useSecrets() {
    const queryClient = useQueryClient();

    const invalidate = (): void => {
        void queryClient.invalidateQueries({ queryKey: SECRETS.of() });
        void queryClient.invalidateQueries({ queryKey: SECRETS_INVENTORY.of() });
    };

    const set = useMutation({
        mutationFn: (input: { key: string; value: string }) => sandboxJson(`/secrets`, jsonBody(`POST`, input)),
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
