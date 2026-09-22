import { computed, type Ref, ref } from "vue";
import type { ChatTurn } from "../transcript";
import { type ChatShot, shotKey } from "./shots";

// The conversation's one picture viewer as a pane holds it: whether it is open, where it opened, and what it walks,
// which is exactly the turns' strips in order, so stepping through it never lands on a picture no strip shows.
export const useShotViewer = (turns: Ref<readonly ChatTurn[]>, turnShots: Ref<ReadonlyMap<number, readonly ChatShot[]>>) => {
    const open = ref(false);
    const start = ref<string>();

    const shots = computed<readonly ChatShot[]>(() => [...turnShots.value.values()].flat());

    // What each turn was asked, for the caption; a turn opened by something other than the user's words has none.
    const prompts = computed<ReadonlyMap<number, string>>(
        () => new Map(turns.value.flatMap((turn) => (turn.messages[0]?.role === `user` ? [[turn.id, turn.messages[0].text] as const] : []))),
    );

    const view = (shot: ChatShot): void => {
        start.value = shot.key;
        open.value = true;
    };

    // A tool card's own picture; false when no strip holds it (the user's attachment read back), for the card to open
    // the file instead.
    const viewCall = (toolId: string, path: string): boolean => {
        const key = shotKey(toolId, path);
        if (!shots.value.some((shot) => shot.key === key)) {
            return false;
        }
        start.value = key;
        open.value = true;
        return true;
    };

    return { open, start, shots, prompts, view, viewCall };
};
