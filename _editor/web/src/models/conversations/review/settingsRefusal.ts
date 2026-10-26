import type { LandConflict } from "@intentic/sandbox-contract/schemas/agents";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, effectScope, type EffectScope, onScopeDispose, shallowRef, watch } from "vue";
import { editsRefusal } from "../../agent-status/agentStatus-attention";
import type { AgentStanding } from "../../agent-status/agentStatus-standing";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { blockersOf, settingsPagesOf, userBlockers } from "./conflictResolution";
import { ownerHoldOf, type OwnerHold } from "./ownerHold";

// The Sandbox pages behind a card's refused land, when the refusal is the owner's half and a page wrote every file in
// it: the board card then names them in the review page's words rather than "Your edits". Read off the review's own
// query (agents.diff, the same key, so opening the review is warm), and only while `refusing`: the query lives in a
// scope made then and stopped after, so a board of cards holds no read for the ones that aren't refusing.
// A read held only while `on`: made in a scope of its own then and stopped after, so a board of cards holds no read for
// the ones that don't need it.
const whileOn = <T>(on: () => boolean, read: () => ComputedRef<T | undefined>): ComputedRef<T | undefined> => {
    const held = shallowRef<ComputedRef<T | undefined>>();
    let scope: EffectScope | undefined;
    const stop = (): void => {
        scope?.stop();
        scope = undefined;
        held.value = undefined;
    };
    watch(
        on,
        (live) => {
            stop();
            if (!live) {
                return;
            }
            // Detached: made inside a watcher, whose active scope is not the caller's; stopped with it below.
            scope = effectScope(true);
            held.value = scope.run(read);
        },
        { immediate: true },
    );
    onScopeDispose(stop);
    return computed(() => held.value?.value);
};

export const useWorkspaceRefusal = (
    agent: () => { readonly id: string; readonly sandboxId?: string | undefined },
    refusing: () => boolean,
): ComputedRef<readonly LandConflict[] | undefined> =>
    whileOn(refusing, () => {
        const at = (): string | undefined => agent().sandboxId;
        const { query } = useSandboxQuery({ ...rpcQuery(`agents.diff`, () => ({ id: agent().id }), { at }) }, at);
        return computed(() => query.data.value?.conflicts);
    });

// What the owner's half of that refusal is (a deletion, or edits), read off the owner's own Changes, the Changes panel's
// query, so it is warm wherever that panel has been open. Only while `refusing`, like the refusal itself.
export const useOwnerHold = (
    agent: () => { readonly sandboxId?: string | undefined },
    refusing: () => boolean,
    conflicts: () => readonly LandConflict[] | undefined,
): ComputedRef<OwnerHold | undefined> => {
    const changes = whileOn(refusing, () => {
        const at = (): string | undefined => agent().sandboxId;
        const { query } = useSandboxQuery({ ...rpcQuery(`git.changes`, undefined, { at }) }, at);
        return computed(() => query.data.value);
    });
    return computed(() => ownerHoldOf(userBlockers(blockersOf(conflicts())), changes.value));
};

export const useSettingsRefusal = (
    agent: () => { readonly id: string; readonly sandboxId?: string | undefined },
    refusing: () => boolean,
): ComputedRef<string | undefined> => {
    const conflicts = useWorkspaceRefusal(agent, refusing);
    return computed(() => settingsPagesOf(conflicts.value));
};

// A corner chip over such a refusal, named as the review names it ("Unsaved settings") rather than "Your edits", once the
// pages behind it are known. The board card and the rail's row both draw theirs through here, so the two say the same.
// `deleted`: the owner's half is files they deleted (useOwnerHold), which the corner names as a deletion, not edits.
export const settingsChip = <C extends { readonly label: string }>(chip: C | undefined, agent: AgentStanding, pages: string | undefined, deleted = false): C | undefined => {
    if (chip === undefined || !editsRefusal(agent)) {
        return chip;
    }
    if (pages !== undefined) {
        return { ...chip, label: t(`agents.agentStatus.unsavedSettings`) };
    }
    return deleted ? { ...chip, label: t(`agents.agentStatus.yourDeletion`) } : chip;
};
