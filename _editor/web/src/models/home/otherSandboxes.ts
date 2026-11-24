import type { AttentionReading } from "./homeFacts";
import { orderedSandboxes } from "./homeFacts";

// THE SANDBOX RAIL'S DOOR TO HOME (shell/rail/OtherSandboxes.vue): the reader's other sandboxes as a cluster of up to
// three overlapping circles under the switcher. Pure, so the order and the overflow are pinned without a window.

export interface OtherBox {
    readonly id: string;
    readonly name: string;
    readonly image?: string | null | undefined;
    /** The owner's pick of its colour, which its monogram is drawn in (sandboxColor.ts). */
    readonly color?: string | null | undefined;
    readonly tier: string;
}

/** Where the sandbox Home is making stands, as the cluster wears it (features/home/newSandbox/newSandbox.ts). */
export type MakingState = `running` | `asking` | `failed` | `opening`;

/**
 * THE SANDBOX HOME IS MAKING, which is in no list yet (2026-11-22). Without it a reader who made a second sandbox and went
 * into their first found neither the run nor a way back to it: the cluster was the add tile, since the first was the only
 * sandbox the list had. It is a sandbox to come, so it is one of the circles, the first, ringed while it is made.
 */
export interface MakingBox {
    /** The row it has once made; undefined while the press is still asking for one. */
    readonly id: string | undefined;
    readonly name: string;
    readonly state: MakingState;
}

export interface ClusterSlot {
    readonly id: string;
    readonly name: string;
    readonly image: string | null;
    readonly color?: string | null | undefined;
    // How many cards wait for the reader there; 0 when none or not answered yet.
    readonly needsYou: number;
    // Its last read went unanswered: drawn dim, as Home dims its tile.
    readonly unreachable: boolean;
    // Being made: ringed while it runs, its point warning when it asks something and danger when it stopped.
    readonly making?: MakingState | undefined;
    // Made while the reader was elsewhere and not opened since: the point Home's tile wears for it.
    readonly ready?: boolean | undefined;
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

/** What the cluster draws besides the account's sandboxes: the one being made, and those made while nobody watched. */
export interface ClusterExtras {
    readonly making?: MakingBox | undefined;
    readonly ready?: ReadonlySet<string> | undefined;
}

/** The circle's id for the sandbox being made: its row's, or a stand-in while it has none. */
export const MAKING_SLOT_ID = `new-sandbox`;

const asksReader = (slot: ClusterSlot): boolean => slot.needsYou > 0 || slot.making === `asking` || slot.making === `failed`;
// Ahead of the quiet ones: what asks for the reader, then the sandbox being made, then one made and not yet opened.
const rank = (slot: ClusterSlot): number => (asksReader(slot) ? 0 : slot.making !== undefined ? 1 : slot.ready === true ? 2 : 3);

// Home's own order (homeFacts.ts `orderedSandboxes`, the reader's arrangement included), with every box that needs the reader moved ahead, so a "+n" only ever folds away
// quiet ones and the circle that carries the point is always one that is drawn.
export const clusterOf = (
    boxes: readonly OtherBox[],
    activeId: string | undefined,
    readings: ReadonlyMap<string, AttentionReading>,
    arranged: readonly string[] = [],
    extras: ClusterExtras = {},
): Cluster => {
    const { making, ready } = extras;
    const listed = orderedSandboxes(
        // The row being made is drawn once, as the sandbox being made, even once the list has it.
        boxes.filter((box) => box.id !== activeId && (making?.id === undefined || box.id !== making.id)),
        arranged,
    ).map(
        (box): ClusterSlot => ({
            id: box.id,
            name: box.name,
            image: box.image ?? null,
            color: box.color ?? null,
            needsYou: readings.get(box.id)?.needsYou ?? 0,
            unreachable: readings.get(box.id)?.unreachable ?? false,
            ready: ready?.has(box.id) === true,
        }),
    );
    const made: readonly ClusterSlot[] =
        making === undefined || making.id === activeId
            ? []
            : [{ id: making.id ?? MAKING_SLOT_ID, name: making.name, image: null, needsYou: 0, unreachable: false, making: making.state }];
    const others = [...made, ...listed];
    const ranked = others.toSorted((left, right) => rank(left) - rank(right));
    const room = ranked.length > CIRCLES ? CIRCLES - 1 : CIRCLES;
    return {
        slots: ranked.slice(0, room),
        more: ranked.length - Math.min(room, ranked.length),
        names: others.map((box) => box.name),
        needing: ranked.filter(asksReader).length,
    };
};
