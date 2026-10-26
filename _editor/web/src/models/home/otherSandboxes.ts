import type { AttentionReading } from "./homeFacts";
import { orderedSandboxes } from "./homeFacts";

// THE SANDBOX RAIL'S DOOR TO HOME (shell/rail/OtherSandboxes.vue): the reader's other sandboxes as a cluster of up to
// three overlapping circles under the switcher. Pure, so the order and the overflow are pinned without a window.

export interface OtherBox {
    readonly id: string;
    readonly name: string;
    readonly image?: string | null | undefined;
    readonly role: string;
}

export interface ClusterSlot {
    readonly id: string;
    readonly name: string;
    readonly image: string | null;
    // How many cards wait for the reader there; 0 when none or not answered yet.
    readonly needsYou: number;
    // Its last read went unanswered: drawn dim, as Home dims its tile.
    readonly unreachable: boolean;
}

export interface Cluster {
    readonly slots: readonly ClusterSlot[];
    // Boxes folded into the "+n" circle, which takes the last slot's place.
    readonly more: number;
    // Every other box, for the door's accessible name.
    readonly names: readonly string[];
    // Sandboxes (not cards) that need the reader: what the door's note counts.
    readonly needing: number;
}

const CIRCLES = 3;

// Home's own order (owned boxes first), with every box that needs the reader moved ahead, so a "+n" only ever folds away
// quiet ones and the circle that carries the point is always one that is drawn.
export const clusterOf = (boxes: readonly OtherBox[], activeId: string | undefined, readings: ReadonlyMap<string, AttentionReading>): Cluster => {
    const others = orderedSandboxes(boxes.filter((box) => box.id !== activeId)).map(
        (box): ClusterSlot => ({
            id: box.id,
            name: box.name,
            image: box.image ?? null,
            needsYou: readings.get(box.id)?.needsYou ?? 0,
            unreachable: readings.get(box.id)?.unreachable ?? false,
        }),
    );
    const ranked = [...others.filter((box) => box.needsYou > 0), ...others.filter((box) => box.needsYou === 0)];
    const room = ranked.length > CIRCLES ? CIRCLES - 1 : CIRCLES;
    return {
        slots: ranked.slice(0, room),
        more: ranked.length - Math.min(room, ranked.length),
        names: others.map((box) => box.name),
        needing: ranked.filter((box) => box.needsYou > 0).length,
    };
};
