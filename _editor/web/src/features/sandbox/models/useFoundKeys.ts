import { endpointProvider } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { ProviderKey } from "@intentic/sandbox-contract/state/arrival";
import { useT } from "@intentic/ui/i18n";
import { computed, type InjectionKey, ref } from "vue";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { refreshConnections } from "../../../models/conversations/accounts/useChat-accounts";
import { useOperation } from "../../../workbench/operations/operations";
import { offeredKeys } from "./providerGrid";

// The API keys the owner's devices hold (the daemon's GET /arrivals/keys, migrations/provider-keys.ts), offered on the
// Models page: copied, unlike a sign-in, since a key is not bound to the install that holds it. Read when the owner
// presses Look, by a tier that may connect things; a device asleep, or none at all, is an empty list. (2026-11-24) It
// was read on every open of the page, which had the daemon open whole credential files on every connected computer
// because someone looked at it.

// The page searches and holds the answer; each key is offered in the panel of the tile it belongs to (FoundKeyRows.vue),
// which reads them from here rather than through every panel's props.
export type FoundKeys = ReturnType<typeof useFoundKeys>;
export const FOUND_KEYS: InjectionKey<FoundKeys> = Symbol(`found-keys`);

/** The found keys and the press that copies one in; `added` is the page's own answer once one has. */
export const useFoundKeys = (added: (key: ProviderKey, endpoint: AgentProvider | undefined) => void) => {
    const t = useT();
    const keys = ref<readonly ProviderKey[]>([]);
    const addedHere = ref<ReadonlySet<string>>(new Set());
    const keyRows = computed(() => offeredKeys(keys.value, addedHere.value));
    // Whether the owner has looked this visit: "none found" is said only after a look that found none.
    const keyLook = ref<`idle` | `looking` | `looked`>(`idle`);
    const readKeys = async (): Promise<void> => {
        keyLook.value = `looking`;
        // allow(silent-catch): a list that could not be read offers nothing, which is what the grid says for none.
        keys.value = (await sandboxRaw(`GET /arrivals/keys`).catch(() => ({ keys: [] }))).keys;
        keyLook.value = `looked`;
    };
    // Copying a key in is kept in the operations ledger rather than here: it writes the key and the endpoint and re-reads
    // the connections whether or not this page stays open, and coming back mid-copy has to show it under way, or why it
    // failed. One at a time, tagged with the key it copies; its value is the endpoint the key became.
    const keyCopy = useOperation<AgentProvider | undefined>(`models/keys/add`);
    const adding = computed(() => (keyCopy.busy.value ? keyCopy.operation.value?.tag : undefined));
    const addKey = async (key: ProviderKey): Promise<void> => {
        if (adding.value !== undefined) {
            return;
        }
        const ended = await keyCopy.run({
            what: t(`connect.connect.foundKeyAdding`, { provider: key.label }),
            tag: key.id,
            quiet: true,
            failed: t(`connect.connect.foundKeyFailed`),
            task: async () => {
                const applied = await sandboxRaw(`POST /arrivals/keys/apply`, { input: { ids: [key.id] } });
                const failure = applied.failed[0];
                if (failure !== undefined) {
                    throw new Error(failure.error);
                }
                // The picker reads endpoints off the connection list, which has never heard of this one.
                await refreshConnections();
                const capability = applied.added[0]?.capability;
                return capability === undefined ? undefined : endpointProvider(capability);
            },
        });
        if (ended?.state !== `done`) {
            return;
        }
        // The row turns to Added rather than vanishing under the press that added it.
        addedHere.value = new Set([...addedHere.value, key.id]);
        keys.value = keys.value.map((entry) => (entry.id === key.id ? { ...entry, added: true } : entry));
        keyCopy.dismiss();
        added(key, ended.value);
    };
    // Which key the last copy failed for, so its panel says so at its row.
    const failedKey = computed(() => (keyCopy.failure.value === undefined ? undefined : keyCopy.operation.value?.tag));
    return { keyRows, keyLook, readKeys, adding, keyNotice: keyCopy.failure, failedKey, dismissNotice: keyCopy.dismiss, addKey };
};
