<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import type { SessionMark } from "../ownership";

/* Whose conversation this is, in one token on the line it shares with the model and the branch: a colleague's given
   name, or for one nobody owns, the program that started it (a control token's label). The reader's own is never drawn
   — the caller decides that (sessionMark) — because a mark carried by nearly every card cannot tell two cards apart,
   and the row it used to take costs the lane a card. The full name is in the hover; taking it over or handing it on is
   in the card's menu. The conversation that spawned this one is not whose it is, and has its own line (ParentMark). */

defineProps<{ mark: SessionMark }>();

const t = useT();

const TOKEN = `inline-flex min-w-0 shrink items-center gap-1`;
</script>

<template>
    <span
        v-if="mark.kind === `person`"
        :class="TOKEN"
        :aria-label="t(`agents.ownerMark.ownedBy`, { name: mark.look.name })"
        v-tooltip.top="t(`agents.ownerMark.ownedBy`, { name: mark.look.name })"
    >
        <span class="truncate">{{ mark.look.short }}</span>
    </span>
    <span
        v-else
        :class="TOKEN"
        :aria-label="t(`agents.ownerMark.startedByControlToken`, { tokenLabel: mark.label })"
        v-tooltip.top="t(`agents.ownerMark.startedByProgramHolding`, { tokenLabel: mark.label })"
    >
        <Icon name="key" class="shrink-0 text-2xs" />
        <span class="truncate">{{ mark.label }}</span>
    </span>
</template>
