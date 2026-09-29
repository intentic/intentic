import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, effectScope, type EffectScope, onScopeDispose, shallowRef, watch } from "vue";
import { type AgentStanding, editsRefusal } from "../fleet/agentStatus";
import { rpcQuery } from "../../sandbox/client/rpcQuery";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { settingsPagesOf } from "./conflictResolution";

// The Sandbox pages behind a card's refused land, when the refusal is the owner's half and a page wrote every file in
// it: the board card then names them in the review page's words rather than "Your edits". Read off the review's own
// query (agents.diff, the same key, so opening the review is warm), and only while `refusing`: the query lives in a
// scope made then and stopped after, so a board of cards holds no read for the ones that aren't refusing.
export const useSettingsRefusal = (
    agent: () => { readonly id: string; readonly sandboxId?: string | undefined },
    refusing: () => boolean,
): ComputedRef<string | undefined> => {
    const pages = shallowRef<ComputedRef<string | undefined>>();
    let scope: EffectScope | undefined;
    const stop = (): void => {
        scope?.stop();
        scope = undefined;
        pages.value = undefined;
    };
    watch(
        refusing,
        (on) => {
            stop();
            if (!on) {
                return;
            }
            // Detached: made inside a watcher, whose active scope is not the caller's; stopped with it below.
            scope = effectScope(true);
            pages.value = scope.run(() => {
                const at = (): string | undefined => agent().sandboxId;
                const { query } = useSandboxQuery({ ...rpcQuery(`agents.diff`, () => ({ id: agent().id }), { at }) }, at);
                return computed(() => settingsPagesOf(query.data.value?.conflicts));
            });
        },
        { immediate: true },
    );
    onScopeDispose(stop);
    return computed(() => pages.value?.value);
};

// A corner chip over such a refusal, named as the review names it ("Unsaved settings") rather than "Your edits", once the
// pages behind it are known. The board card and the rail's row both draw theirs through here, so the two say the same.
export const settingsChip = <C extends { readonly label: string }>(chip: C | undefined, agent: AgentStanding, pages: string | undefined): C | undefined =>
    chip !== undefined && pages !== undefined && editsRefusal(agent) ? { ...chip, label: t(`agents.agentStatus.unsavedSettings`) } : chip;
