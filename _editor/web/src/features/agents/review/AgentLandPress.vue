<!-- The review's one primary press, in whichever form this reader gets it: Fix conflicts, Land now, Request land, or the fact that it was asked. -->
<script setup lang="ts">
import { Button, type Tip } from "@intentic/ui";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { useT } from "@intentic/ui/i18n";

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
    /**
     * A refused land the agent can clear: the press becomes the fix, since landing again would only be refused again.
     * `queued` waits for the running turn to end; `working` is the fix turn itself.
     */
    fix?: { readonly count: number; readonly state: `ready` | `queued` | `working`; readonly busy: boolean } | undefined;
}>();

const emit = defineEmits<{ land: []; request: []; fix: [] }>();

const words = useVocabulary();
const t = useT();
</script>

<template>
    <!-- While it is queued or running the press is a fact, not a second ask; the conflict bar carries its Cancel and Stop. -->
    <Button
        v-if="fix !== undefined"
        :size="block ? undefined : `small`"
        :tier="fix.state === `ready` ? `accent` : `boring`"
        :thumb="block"
        class="shrink-0 whitespace-nowrap"
        :class="block ? `w-full` : ``"
        :disabled="fix.state !== `ready` || fix.busy"
        @click="emit(`fix`)"
        v-tooltip.bottom="fix.state === `ready` ? t(`agents.agentLandPress.fixHint`) : undefined"
    >
        <template v-if="fix.state === `working`"><Icon name="spinner" spin />{{ t(`agents.agentLandPress.fixing`) }}</template>
        <template v-else-if="fix.state === `queued`"><Icon name="clock" />{{ t(`agents.agentLandPress.fixQueued`) }}</template>
        <template v-else><Icon name="sparkles" />{{ t(`agents.agentLandPress.fix`, { count: fix.count }, fix.count) }}</template>
    </Button>
    <!-- Success-toned with the check glyph, matching the board card's own Land now: the same action on the same work reads as such. -->
    <Button
        v-else-if="canShip"
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
