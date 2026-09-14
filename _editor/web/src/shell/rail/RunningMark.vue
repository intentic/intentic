<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { RUNNING_MARK_CLASS } from "../../core-views/viewBadge";

/* Running state is shared by every tile surface. */
</script>

<template>
    <!-- aria-hidden: the sentence is already in the tile's own label, and a second voice here would say it twice. -->
    <span class="flex leading-none" :class="RUNNING_MARK_CLASS" aria-hidden="true">
        <Icon name="spinner" spin class="text-[0.75rem]" />
    </span>
</template>
