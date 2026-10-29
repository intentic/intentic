import type {
    CredentialGate,
    CredentialGateKind,
    SecretInventoryEntry,
    CredentialPolicySet,
    SecretProgramGuard,
    SecretPrograms,
} from "@intentic/sandbox-contract/schemas/secrets";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { devFillSet } from "../../app/devFill";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { rpcKey } from "../../lib/queryKeys";
import type { MembersRoster } from "@intentic/sandbox-contract/schemas/members";
import { useAccess } from "../../client/sandbox/access/useAccess";
import { useMembers } from "../../client/sandbox/useMembers";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { useSandboxSession } from "../../client/session/sandboxSession";

// User-supplied env-var secrets, written straight to the daemon's /secrets routes, split by consumer so each
// surface only observes the server state it reads (an observer mount refetches its query). `reveal` is for whoever runs
// secrets, and deliberately not a query, so a value never enters the cache.

// The owner, Full access, or someone given Secrets, and of a gated secret only its approvers; anyone else gets the
// daemon's 403 message as a thrown Error. Plain async on purpose (no cache).
export const reveal = async (key: string): Promise<string> => (await sandboxRpc.secrets.reveal({ key })).value;

export function useSecretKeys() {
    const { query, error } = useSandboxQuery({
        queryKey: rpcKey(`secrets.list`),
        // 412 until DevOps is active: no .env holds keys yet. Any other refusal is a failed read, never "no keys".
        queryFn: () =>
            sandboxRpc.secrets.list().catch((failure: unknown) => {
                if (failure instanceof SandboxHttpError && failure.status === 412) {
                    return { keys: [] };
                }
                throw failure;
            }),
    });
    return {
        hasKey: (key: string): boolean => (query.data.value?.keys ?? []).includes(key),
        // Why the keys are unknown after a failed read, while hasKey answers false for every key.
        keysError: error,
    };
}

// "Missing" means a secret the intent declares that the sandbox lacks; generated and capability/provider entries
// aren't the user's to set, so they don't count.
const missingRequired = (entries: readonly SecretInventoryEntry[]): number =>
    entries.filter((entry) => entry.kind === `env` && entry.requiredBy.length > 0 && entry.status === `missing`).length;

export function useSecretInventory() {
    const queryClient = useQueryClient();
    const { query, loaded } = useSandboxQuery(rpcQuery(`secrets.inventory`));
    const inventory = computed<SecretInventoryEntry[]>(() => query.data.value?.entries ?? []);
    return {
        inventory,
        missingRequiredCount: computed(() => missingRequired(inventory.value)),
        // Waited for until the first answer lands, so the page never shows a fake empty state.
        loaded,
        refreshInventory: (): void => void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.inventory`) }),
    };
}

// Attention count for app-wide chrome, mounted regardless of whether a secrets surface is open. Same query as the
// inventory but with its own staleTime/no-refetch-on-focus, since /secrets/inventory is an expensive fan-out that a
// permanently mounted observer would otherwise re-run on every window focus. Writes still invalidate it, so the
// badge updates immediately; only ambient polling is skipped.
const AMBIENT_STALE_MS = 5 * 60 * 1000;
export function useMissingSecretCount() {
    const { query } = useSandboxQuery({
        ...rpcQuery(`secrets.inventory`),
        staleTime: AMBIENT_STALE_MS,
        refetchOnWindowFocus: false,
    });
    return {
        missingRequiredCount: computed(() => missingRequired(query.data.value?.entries ?? [])),
        countPending: computed(() => query.isPending.value),
    };
}

// Who may be offered as an approver, first to last: the owner (the answer people reach for most), then the roster, then
// the reader, then everybody a gate already names. Without the roster, which only whoever runs people and access reads,
// the reader and the names already on a gate are all there is: enough to name oneself, and to take somebody off. Compared
// lowercased, since the roster normalizes on write but a Google claim may preserve case; the first spelling stays.
export const approverChoicesOf = (roster: MembersRoster | undefined, reader: string | undefined, gates: readonly CredentialGate[]): string[] => {
    const named = [
        ...(roster?.owner === undefined ? [] : [roster.owner]),
        ...(roster?.members ?? []).map((member) => member.email),
        ...(reader === undefined ? [] : [reader]),
        ...gates.flatMap((gate) => gate.approvers),
    ];
    const seen = new Set<string>();
    return named.filter((email) => {
        const key = email.toLowerCase();
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};

// Who may release what, and who could be named: the approval editor needs both, so one hook covers policy
// (`/secrets/gates`) and roster (`/members`). Whoever runs secrets writes them (the owner, Full access, or someone given
// Secrets; the daemon enforces it); `runsSecrets` just renders the editors read-only for anyone else, instead of offering
// controls that would be refused.
export function useCredentialGates() {
    const queryClient = useQueryClient();
    // An unwritten policy answers an empty list; anything else is a real error, surfaced rather than drawing a sandbox
    // with no gates.
    const { query: gatesQuery } = useSandboxQuery(rpcQuery(`secrets.gates`));
    const { holds } = useAccess();
    // The roster is read only by whoever runs people and access; anyone else would be refused, so is not asked.
    const namesEveryone = computed(() => holds(`people`));
    const { roster } = useMembers({ enabled: namesEveryone });
    const { presentedEmail } = useSandboxSession();
    // The inventory too: a closed row says who must release it from the gate the inventory carries.
    const invalidate = (): void => {
        void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.gates`) });
        void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.inventory`) });
    };
    const setGate = useMutation({
        mutationFn: (gate: CredentialGate) => sandboxRpc.secrets.setGate(gate),
        onSuccess: invalidate,
    });
    const removeGate = useMutation({
        mutationFn: (subject: string) => sandboxRpc.secrets.removeGate({ subject }),
        onSuccess: invalidate,
    });
    const gates = computed<CredentialGate[]>(() => gatesQuery.data.value?.gates ?? []);
    return {
        gates,
        gateFor: (subject: string): CredentialGate | undefined => gates.value.find((gate) => gate.subject === subject),
        approverChoices: computed<string[]>(() =>
            approverChoicesOf(namesEveryone.value ? roster.value : undefined, presentedEmail.value?.toLowerCase(), gates.value),
        ),
        // Whether the choices hold everybody who could be named, or only the reader and the names already on a gate.
        namesEveryone,
        runsSecrets: computed<boolean>(() => holds(`secrets`)),
        setGate,
        removeGate,
    };
}

// Each secret's host guard. The row reads it off the inventory, so an edit writes and refreshes that; the daemon decides
// whether the caller may make it (whoever runs secrets loosens, anybody tightens).
export function useSecretHosts() {
    const queryClient = useQueryClient();
    const setHosts = useMutation({
        mutationFn: (input: { subject: string; kind: CredentialGateKind; guard: boolean; hosts: string[] }) => sandboxRpc.secrets.setHosts(input),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.inventory`) }),
    });
    return { setHosts };
}

// Each sandbox-held secret's program guard: which windows on the owner's computers, and which phone apps, it is typed
// into unasked. Read from its own route, since a secret whose list was never set is simply absent there; an edit writes
// and refreshes that and the inventory, whose rows carry the same list. A keyring's own entries are not here: their list
// is the keyring's, on its row.
export function useSecretPrograms() {
    const queryClient = useQueryClient();
    const { query } = useSandboxQuery(rpcQuery(`secrets.programs`));
    const setPrograms = useMutation({
        mutationFn: (input: SecretProgramGuard) => sandboxRpc.secrets.setPrograms(input),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.programs`) });
            void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.inventory`) });
        },
    });
    return {
        programsFor: (subject: string): Omit<SecretPrograms, `source`> | undefined =>
            (query.data.value?.guards ?? []).find((guard) => guard.subject === subject),
        setPrograms,
    };
}

// How a connection's credential reaches the agent, and the rules the credential gateway enforces on it. Changed by whoever
// runs secrets; the row reads it off the inventory, so an edit writes and refreshes that.
export function useCredentialPolicy() {
    const queryClient = useQueryClient();
    const setPolicy = useMutation({
        mutationFn: (input: CredentialPolicySet) => sandboxRpc.secrets.setPolicy(input),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.inventory`) }),
    });
    return { setPolicy };
}

export function useSecrets() {
    const queryClient = useQueryClient();

    const invalidate = (): void => {
        void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.list`) });
        void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.inventory`) });
    };

    const set = useMutation({
        mutationFn: (input: { key: string; value: string }) => sandboxRpc.secrets.set(input),
        // Every .env secret write funnels through here, so this one hook feeds the dev autofill for all of them.
        onSuccess: (_data, input) => {
            invalidate();
            devFillSet(`secret.${input.key}`, input.value);
        },
    });

    const remove = useMutation({
        mutationFn: (key: string) => sandboxRpc.secrets.remove({ key }),
        onSuccess: invalidate,
    });

    return { set, remove };
}
