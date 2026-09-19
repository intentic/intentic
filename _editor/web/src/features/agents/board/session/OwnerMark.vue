<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { RouterLink } from "vue-router";
import type { SessionMark } from "../ownership";

/* Whose conversation this is, in one token on the line it shares with the model and the branch: a colleague as a
   coloured dot and a given name, or for one nobody owns, the program that started it (a control token's label) or the
   conversation that spawned it (a link to the parent). The reader's own is never drawn — the caller decides that
   (sessionMark) — because a mark carried by nearly every card cannot tell two cards apart, and the row it used to
   take costs the lane a card. The full name is in the hover; taking it over or handing it on is in the card's menu. */

defineProps<{ mark: SessionMark }>();

const t = useT();

const TOKEN = `inline-flex min-w-0 shrink items-center gap-1`;
</script>

<template>
    <span
        v-if="mark.kind === `person`"
        :class="[TOKEN, `text-content`]"
        :aria-label="t(`agents.ownerMark.ownedBy`, { name: mark.look.name })"
        v-tooltip.top="t(`agents.ownerMark.ownedBy`, { name: mark.look.name })"
    >
        <!-- The accent Avatar fills a circle with, at the size a mark on a meta line can afford: the same dot as this
             person's chip in the board header, so one press filters to what the eye already grouped. -->
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :style="{ backgroundColor: `hsl(${mark.look.hue} 55% 52%)` }" />
        <span class="truncate font-medium">{{ mark.look.short }}</span>
    </span>
    <span
        v-else-if="mark.kind === `token`"
        :class="TOKEN"
        :aria-label="t(`agents.ownerMark.startedByControlToken`, { tokenLabel: mark.label })"
        v-tooltip.top="t(`agents.ownerMark.startedByProgramHolding`, { tokenLabel: mark.label })"
    >
        <Icon name="key" class="shrink-0 text-2xs" />
        <span class="truncate">{{ mark.label }}</span>
    </span>
    <RouterLink
        v-else
        :to="{ name: `agent`, params: { id: mark.parent } }"
        :class="[TOKEN, `hover:text-content`]"
        :aria-label="t(`agents.ownerMark.spawnedBy`, { parent: mark.parent })"
        v-tooltip.top="t(`agents.ownerMark.spawnedBy`, { parent: mark.parent })"
        @click.stop
    >
        <Icon name="sitemap" class="shrink-0 text-2xs" />
        <span class="truncate">{{ mark.parent }}</span>
    </RouterLink>
</template>
