<script setup lang="ts">
import { Row, RowGroup, RowNote } from "@intentic/ui";
import { useRole } from "../../composables/sandbox/useRole";
import ArrivalPanel from "./ArrivalPanel.vue";
import MoveOutPanel from "./MoveOutPanel.vue";

/* MOVING THIS SANDBOX, BOTH DIRECTIONS ON ONE CARD, because they are two halves of one job and a reader who
 * has one of them in mind has the other one in mind a minute later.
 *
 * IT WAS TWO CARDS: "Take this sandbox elsewhere" and "Bring a sandbox in". Splitting by DIRECTION was the
 * right axis — it replaced a split by ARTIFACT that had a definition and a bundle on separate cards, which is
 * how owners exported gigabytes without ever discovering the publishable document — but direction is a
 * distinction INSIDE one subject, not a reason for two subjects. Two cards said "these are different things".
 * They are not: they are out and in, and the thing they are about is the same sandbox and the same three
 * artifacts. Side by side, the pairing does work no separate card could — the bundle you export is the bundle
 * the other end brings in, and the reader can now see both ends of that sentence at once.
 *
 * THE HIERARCHY IS EYEBROW → PANEL → GROUP. The card's own name is <RowGroup>'s uppercase label, floating above
 * the surface; each half opens with a one-word heading and nothing else; and the lists inside
 * (Workspace, Exports, Your computers) keep the small uppercase group labels they always had. Three registers,
 * so nothing has to compete with anything, and <RowGroup>'s own hairline between direct children draws the seam
 * between the halves for free.
 *
 * <RowNote variant="block"> RATHER THAN A PADDED <div>: a block on a group's surface takes the group's own
 * padding from the tier table (ROW_BLOCK_PAD), which is the difference between these two halves sitting flush
 * with the rows inside them and sitting a few pixels off them forever. Both old cards hand-wrote `p-5` and both
 * were flagged for it.
 *
 * THE ROLE CHECK IS HERE AND NOT IN THE PANELS. It was two sentences, one per card, saying the same thing about
 * the same permission. Moving is moving; a maintainer may do it in either direction or in neither. */

const { canShip: canOperate } = useRole();
</script>

<template>
    <RowGroup label="Move this sandbox">
        <template v-if="canOperate">
            <RowNote variant="block">
                <div class="flex flex-col gap-4">
                    <Row flush density="comfortable" :heading="3" icon="arrow-up-right" title="Export" />
                    <MoveOutPanel />
                </div>
            </RowNote>

            <RowNote variant="block">
                <div class="flex flex-col gap-4">
                    <Row flush density="comfortable" :heading="3" icon="arrow-down-left" title="Import" />
                    <ArrivalPanel />
                </div>
            </RowNote>
        </template>

        <RowNote v-else icon="lock">Owner only.</RowNote>
    </RowGroup>
</template>
