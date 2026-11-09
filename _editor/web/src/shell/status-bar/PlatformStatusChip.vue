<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { computed } from "vue";
import { t } from "@intentic/ui/i18n";
import { environment } from "../../app/environments/environment";
import { directMode } from "../../client/directory/directState";
import { platformHealth } from "../../lib/platform/platformHealth";

// THE WHOLE OUTAGE, IN ONE CHIP (2026-11-09). While Intentic's servers don't answer (lib/platform/platformHealth.ts),
// or this window is open on its sandboxes without them (features/sandbox/recovery/directMode.ts), the status bar says so
// here and nowhere louder: the sandboxes keep working, and what waits for the platform (sharing, billing, a new sandbox)
// says so where it is pressed. A press opens the public status page, which says whether the outage is ours and when it
// started; the chip itself goes away by itself the moment the platform answers again.

// Only intentic.dev has a status page; a self-hosted platform's api host names none.
const statusPage = ((): string | undefined => {
    try {
        return new URL(environment.api.url).hostname === `api.intentic.dev` ? `https://status.intentic.dev` : undefined;
    } catch {
        // allow(silent-catch): an api address that is not a URL names no status page.
        return undefined;
    }
})();

const shown = computed(() => platformHealth.down.value || directMode.value);

const press = (): void => {
    if (statusPage !== undefined) {
        globalThis.open(statusPage, `_blank`, `noopener`);
        return;
    }
    void platformHealth.checkNow();
};
</script>

<template>
    <button
        v-if="shown"
        type="button"
        data-chip="platform"
        class="flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-muted transition-colors hover:bg-content/5 hover:text-content"
        :aria-label="t(`shell.platformStatus.detail`)"
        v-tooltip.top="{ title: t(`shell.platformStatus.label`), note: t(`shell.platformStatus.note`) }"
        @click="press"
    >
        <span class="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true"></span>
        <Icon name="cloud" class="shrink-0 text-xs" />
        <span class="truncate">{{ t(`shell.platformStatus.label`) }}</span>
    </button>
</template>
