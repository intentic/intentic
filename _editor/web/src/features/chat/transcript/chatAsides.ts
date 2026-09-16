import type { IconName } from "@intentic/ui";

// One mark in the transcript's lane (ChatAsideLane): what it looks like and what it stands for. Its own module so the
// component can be imported for its markup and the shape for its type.

export interface ChatAsideMark {
    // Names the slot its material is passed in, and which mark a row has open.
    readonly key: string;
    readonly icon: IconName;
    // What the mark stands for, for the pointer and the screen reader alike: the lane has no room to write it.
    readonly label: string;
    readonly count?: number;
    // Still being written: spins in the glyph's place, so a shut mark still reads as live.
    readonly busy?: boolean;
    readonly failed?: boolean;
}
