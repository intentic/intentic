<!-- The Finished lane's header acts (AgentsView): the lane's fold ("N earlier" / "Show fewer"), the archive's door that opens it, the
     lane's Clear, and inside the archive its Delete all. A slim board (boardGrid.ts `CardFit`) keeps fewer of them: a mini
     one drops Clear, the one bulk act nobody needs from a sliver, and a tile one keeps none, its lane's glyph being all
     the header there is. -->
<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import type { BoardView } from "./view/boardView";
import type { CardFit } from "./view/boardGrid";

defineProps<{
    view: BoardView;
    filtering: boolean;
    // Whether the lane offers its fold (cornerFit.ts `tailed`), and how many cards it leaves out while folded.
    tailed: boolean;
    earlier: number;
    // How many cards sit in the archive.
    archiveSize: number;
    // The archive's counter flashes as a card lands in it (archiveDoor.ts).
    pulsing: boolean;
    // How many cards Clear would file away; 0 where Clear is not this reader's to press.
    clearable: number;
    // How many the archive holds on this sandbox, which its Delete all deletes.
    archived: number;
    purging: boolean;
    fit: CardFit;
}>();
const emit = defineEmits<{ fewer: []; door: []; clear: []; purge: [] }>();

const t = useT();
const words = useVocabulary();
</script>

<template>
    <template v-if="fit !== `tile` && !view.archive">
        <!-- The lane's fold, both ways, in one place: the cards it leaves out when folded, the way back once opened. Sized
             as the archive counter beside it (sm, 20px), so the header's chips read as one set. -->
        <button
            v-if="tailed && !filtering"
            type="button"
            :class="ui.chip({ size: `sm` }, `shrink-0`)"
            data-fold
            @click="emit(`fewer`)"
        >
            <Icon :name="view.all ? `chevron-up` : `chevron-down`" class="text-2xs" />{{ view.all ? t(`ui.action.showFewer`) : t(`ui.action.showEarlier`, { count: earlier }) }}
        </button>
        <!-- The archive's door: a bare glyph, its count in the hover and the label. The count was a figure nobody acts on (4738
             or 4739), and a pill round it read as a status tag rather than a way in. It lights while a card lands in it
             (archiveDoor.ts), the one moment the door has news. xs (20px), the chip beside it's height, so the row stays one set. -->
        <button
            v-if="archiveSize > 0"
            type="button"
            :aria-label="t(`agents.agentsView.openArchive`, { archiveSize })"
            v-tooltip.bottom="{ title: t(`shared.archived`), rows: [{ label: words.agents, value: archiveSize }], note: t(`agents.words.allKept`) }"
            :class="ui.iconButton({ size: `xs`, on: pulsing }, pulsing && `text-primary-500 ring-1 ring-primary-500/50`)"
            data-archive-door
            @click="emit(`door`)"
        >
            <Icon name="history" class="text-2xs" />
        </button>
        <!-- Hidden while filtering, like the drag: Clear archives the whole lane, not the filtered subset on screen. -->
        <Button
            v-if="clearable > 0 && !filtering && fit !== `mini`"
            size="small"
            tier="quiet"
            thumb
            class="shrink-0"
            :aria-label="t(`agents.agentsView.archiveEveryFinishedAgent`)"
            v-tooltip.bottom="{ title: t(`agents.agentsView.archiveAll`), rows: [{ label: words.agents, value: clearable }], note: t(`agents.words.undoable`) }"
            @click="emit(`clear`)"
        >
            {{ t(`ui.action.clear`) }}
        </Button>
    </template>
    <!-- Retired-agent danger appears on hover; the dialog is the actionable warning. -->
    <Button
        v-else-if="fit !== `tile` && archiveSize > 0 && !filtering"
        size="small"
        tier="quiet"
        tone="danger"
        class="shrink-0"
        :aria-label="t(`agents.agentsView.deleteAllArchivedAgents`, { count: archived })"
        :disabled="purging"
        v-tooltip.bottom="{ title: t(`agents.agentsView.deleteAll`), rows: [{ label: words.agents, value: archived }], note: t(`agents.words.cantUndo`) }"
        @click="emit(`purge`)"
    >
        <Icon :name="purging ? 'spinner' : 'trash'" :spin="purging" class="text-2xs" />{{ t(`agents.agentsView.deleteAll`) }}
    </Button>
</template>
