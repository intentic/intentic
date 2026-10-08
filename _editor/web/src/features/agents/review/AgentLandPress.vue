<!-- The review's one primary press, in whichever form this reader gets it: Land now, Request land, or the fact that it was asked. -->
<script setup lang="ts">
import { Button, type Tip } from "@intentic/ui";
import { useVocabulary } from "../../../workbench/views/vocabulary";

// One body for the desktop header and a phone's Changes screen, so the role split (maintainers land, collaborators
// ask, the daemon enforcing the floor either way) is decided in one template rather than kept in step across two.
const { block = false } = defineProps<{
    /** A maintainer, whose press lands. */
    canShip: boolean;
    /** Whether a collaborator has already asked, which turns their press into a fact. */
    requested: boolean;
    /** Land is pressed out: something else is in flight, or nothing is pending. */
    landDisabled: boolean;
    /** The ask is on its way. */
    requesting: boolean;
    landHint: Tip;
    requestHint: Tip;
    /** A phone's full-width, thumb-high press under the review, rather than the header's small one. */
    block?: boolean;
}>();

const emit = defineEmits<{ land: []; request: [] }>();

const words = useVocabulary();
</script>

<template>
    <!-- Success-toned with the check glyph, matching the board card's own Land now: the same action on the same work reads as such. -->
    <Button
        v-if="canShip"
        :size="block ? undefined : `small`"
        tone="success"
        :thumb="block"
        class="shrink-0 whitespace-nowrap"
        :class="block ? `w-full` : ``"
        :disabled="landDisabled"
        @click="emit(`land`)"
        v-tooltip.bottom="landHint"
    >
        <Icon name="check" />{{ words.land }}
    </Button>
    <!-- The collaborator's copy of the press above; once asked it becomes a fact instead of a press. -->
    <span v-else-if="requested" class="inline-flex shrink-0 items-center gap-1 text-2xs text-muted" :class="block ? `w-full justify-center py-2` : ``">
        <Icon name="clock" class="text-2xs" />{{ words.landRequested }}
    </span>
    <Button
        v-else
        :size="block ? undefined : `small`"
        tier="boring"
        :thumb="block"
        class="shrink-0 whitespace-nowrap"
        :class="block ? `w-full` : ``"
        :disabled="requesting"
        @click="emit(`request`)"
        v-tooltip.bottom="requestHint"
    >
        <Icon :name="requesting ? 'spinner' : 'send'" :spin="requesting" />{{ words.requestLand }}
    </Button>
</template>
