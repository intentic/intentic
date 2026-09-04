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
import { devFillSet } from "../devFill";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { SANDBOX_MEMBERS, SECRET_GATES, SECRETS, SECRETS_INVENTORY } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { useSandboxSession } from "../sandbox/sandboxSession";

/* User-supplied env-var secrets (Cloudflare token, GitHub PAT, another-host SSH key), written straight to the
 * sandbox daemon's /secrets routes (never through the platform). Split by consumer so a surface only observes
 * the server state it reads (an observer mount refetches its query, so bundling made every SecretEntryRow
 * refire both): `useSecretKeys` is the KEYS-ONLY list (hasKey checks in credential forms), `useSecretInventory`
 * the unified view (env + generated + capabilities + AI providers, with status/provenance/CI state, never
 * values), `useMissingSecretCount` that same inventory reduced to the one number the always-mounted chrome
 * shows, `useSecrets` the mutations; `reveal` is the single value-returning call, owner-only, and
 * deliberately NOT a query so a secret value never enters the query cache or its IndexedDB persistence. */

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

// The one definition of "missing" every surface shouts about: a secret the INTENT declares that the sandbox
// does not have. Generated values (the first deploy produces them) and capability/provider entries are not the
// user's to set, so an unset one is not an outstanding task, counting those would make the chrome cry wolf.
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
        // isPending, not isLoading: true from mount until the FIRST data (even while `reachable` still gates the
        // fetch), so the page shows its reading placeholder instead of fake empty states during the handshake.
        inventoryPending: computed(() => query.isPending.value),
        refreshInventory: (): void => void queryClient.invalidateQueries({ queryKey: inventoryKey }),
    };
}

// Just the attention count, for the AMBIENT chrome, the rail's sandbox chip, the mobile menu row, the sandbox
// overview, which is mounted app-wide rather than on a secrets surface. Same query, deliberately different
// observer options: /secrets/inventory is a fan-out (a digest per secret over the desired-state repo, the
// capability list, the connector registry, an HTTP call to the cliproxy's account API), and the client's
// default freshness is staleTime 0 + refetch-on-focus, so a permanently mounted observer would re-run that
// aggregate on every window focus of every page, for every user, secrets surface open or not. Every write
// invalidates the key (useSecrets below), so the badge still moves the instant a value is set; only the
// ambient POLLING is dropped. Kept a separate hook, not an option on the one above, for the same reason the
// keys/inventory/mutations split exists at all: a surface observes only the server state it actually reads.
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

/* WHO MAY RELEASE WHAT, and who could be named: the Secrets tab's approval editor reads both, so they are one
 * hook. The POLICY is the daemon's `/secrets/gates`; the ROSTER is `/members`, which answers the granted
 * members and the bound owner (the owner rides along precisely so they can name themselves, which is the
 * obvious first gate somebody writes and was the one that could not be expressed).
 *
 * Its own hook rather than options on the inventory above, on this file's own rule: a surface observes only
 * the server state it reads, and the ambient chrome that watches the missing-secret count must not start
 * polling an approval policy it never renders.
 *
 * ONLY THE OWNER MAY WRITE, enforced in the daemon's route (a maintainer is exactly who a gate is sometimes
 * written about, so the /secrets maintainer floor is not enough). `isOwner` is what the UI reads to render the
 * editor read-only instead of offering controls that will 403; it is a courtesy, and the route is the rule. */
export function useCredentialGates() {
    const queryClient = useQueryClient();
    const gatesKey = SECRET_GATES.of();
    const { query: gatesQuery } = useSandboxQuery({
        queryKey: gatesKey,
        // A daemon whose policy has never been written answers an empty list; anything else (an unreadable
        // policy) is a real error, and the tab surfaces it rather than drawing a sandbox with no gates.
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
        /* Everybody who could be named, owner first: the owner is the answer people reach for most and the
         * roster below them is alphabetical wherever the daemon put it. Deduplicated because an owner who is
         * also on the members file (a re-grant, an older sandbox) must not appear twice in a picker. */
        approverChoices: computed<string[]>(() => {
            const roster = rosterQuery.data.value;
            return [...new Set([...(roster?.owner === undefined ? [] : [roster.owner]), ...(roster?.members ?? []).map((member) => member.email)])];
        }),
        // Compared lowercased for the roster's own reason: every write to it normalizes, while a Google claim
        // may preserve case.
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
