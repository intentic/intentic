<!-- HOME, AT THE HEAD OF A SANDBOX'S RAIL: the way back out to the master view, every sandbox at once, one press from
     anywhere inside one. It used to be a small mark on the header of the switcher's panel, quiet until looked for; since
     Home became the first screen (2026-10-25) going in and coming back out are the two moves the app is built around.
     Named with its keystroke, as the palette names it (workbench/commands/builtinCommands.ts `view.home`). A guest of a
     box has no Home, unless Home is all it has. -->
<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useRole } from "../../client/sandbox/useRole";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { commandShortcut } from "../../workbench/commands/useCommands";

const t = useT();
const { isGuest, homeOnly } = useRole();
const note = computed(() => [t(`home.tileNote`), commandShortcut(`view.home`)].filter((part) => part !== undefined && part !== ``).join(` · `));
</script>

<template>
    <RouterLink
        v-if="!isGuest || homeOnly"
        :to="HOME_PATH"
        class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex shrink-0 items-center justify-center rounded-lg text-muted hover:text-content"
        :aria-label="`${t(`home.title`)} · ${t(`home.tileNote`)}`"
        v-tooltip.right="{ title: t(`home.title`), note }"
        data-rail-home
    >
        <Icon name="th-large" class="icon-rail-glyph" aria-hidden="true" />
    </RouterLink>
</template>
