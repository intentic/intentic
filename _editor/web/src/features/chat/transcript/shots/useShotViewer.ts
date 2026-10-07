import { computed, type Ref, ref } from "vue";
import type { ChatTurn } from "../transcript";
import { type ChatShot, shotKey, sortShots, type SortedShots } from "./shots";
import { shotLook } from "./shotLooks";

// The conversation's one picture viewer as a pane holds it: whether it is open, where it opened, and what it walks,
// which is exactly the turns' strips in order, so stepping through it never lands on a picture no strip shows. Also
// which turns the reader asked to see the set-aside pictures of (sortShots): a strip's own press, or a tool card's
// picture opened in the viewer, which is asking to see it.
export const useShotViewer = (
    turns: Ref<readonly ChatTurn[]>,
    turnShots: Ref<ReadonlyMap<number, readonly ChatShot[]>>,
    // Whose checkout the pictures are read in (thumbnails.ts), undefined for the shared tree.
    agent: Ref<string | undefined>,
) => {
    const open = ref(false);
    const start = ref<string>();
    // Turns whose set-aside pictures the reader asked to see; replaced, not mutated, so a strip reading it redraws.
    const revealed = ref<ReadonlySet<number>>(new Set());

    const sorted = (shots: readonly ChatShot[]): SortedShots => sortShots(shots, (shot) => shotLook(agent.value, shot.path));

    // A turn's pictures as its strip draws them. Reading it asks for the looks of every one, so only a strip near the
    // viewport or the open viewer reads it.
    const displayed = (turnId: number, shots: readonly ChatShot[]): readonly ChatShot[] => (revealed.value.has(turnId) ? shots : sorted(shots).shown);

    const shots = computed<readonly ChatShot[]>(() => [...turnShots.value.entries()].flatMap(([turnId, of]) => displayed(turnId, of)));

    const reveal = (turnId: number, shown: boolean): void => {
        const next = new Set(revealed.value);
        if (shown) {
            next.add(turnId);
        } else {
            next.delete(turnId);
        }
        revealed.value = next;
    };

    // What each turn was asked, for the caption; a turn opened by something other than the user's words has none.
    const prompts = computed<ReadonlyMap<number, string>>(
        () => new Map(turns.value.flatMap((turn) => (turn.messages[0]?.role === `user` ? [[turn.id, turn.messages[0].text] as const] : []))),
    );

    const view = (shot: ChatShot): void => {
        start.value = shot.key;
        open.value = true;
    };

    // A tool card's own picture; false when no strip holds it (the user's attachment read back), for the card to open
    // the file instead. A picture its strip set aside is shown along with the rest of that turn's: it was asked for.
    const viewCall = (toolId: string, path: string): boolean => {
        const key = shotKey(toolId, path);
        const shot = [...turnShots.value.values()].flat().find((each) => each.key === key);
        if (shot === undefined) {
            return false;
        }
        if (!displayed(shot.turnId, turnShots.value.get(shot.turnId) ?? []).some((each) => each.key === key)) {
            reveal(shot.turnId, true);
        }
        start.value = key;
        open.value = true;
        return true;
    };

    return { open, start, shots, prompts, revealed, reveal, view, viewCall };
};
