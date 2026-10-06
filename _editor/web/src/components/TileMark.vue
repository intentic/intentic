<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import type { IconName } from "@intentic/ui/icons";

/* The bare corner mark: work in flight, or a standing note. Shared by the rail and the phone tab bar. */

const { name, spin = false } = defineProps<{ name: IconName; spin?: boolean }>();
</script>

<template>
<!-- No plate, and nothing punched out behind it either: a ground-coloured disc bites a visible hole in the glyph
     underneath, which reads as a damaged icon rather than a mark laid on one. What it shares with ViewBadgeChip is
     the type size and the corner — a plate is what separates an errand with a number from a quiet mark. -->
<!-- 1.1em, not the chip's 0.9: a bare glyph needs to be a little larger than a plated one to weigh the same. -->
<!-- aria-hidden: the sentence is already in the tile's own label, and a second voice here would say it twice. -->
    <span class="inline-flex leading-none" aria-hidden="true">
        <Icon :name="name" :spin="spin" class="text-[1.1em]" />
    </span>
</template>
