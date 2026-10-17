<script setup lang="ts">
import { BrandMark, Row, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import type { ExtensionEntry } from "../../extensions/useExtensionList";
import { devLineOf } from "./extensionDev";
import ExtensionSwitch from "./ExtensionSwitch.vue";
import { useT } from "@intentic/ui/i18n";

// One installed extension as one line, the way Capabilities lists a connection: its name and where it shows up, what is
// wrong with it when something is, then its state and its switch. Pressing the line opens the extension's page in the
// list's place (ExtensionDetail); the switch is the one control a row keeps, because on and off is what people come
// to this list to do. Tier and mark size come from the list's own RowGroup density, not this file.

const t = useT();

const { entry, pending } = defineProps<{ entry: ExtensionEntry; pending: boolean }>();

const emit = defineEmits<{ toggle: [enabled: boolean]; open: [] }>();

const manifest = computed(() => entry.extension.manifest);
const devLine = computed(() => devLineOf(entry.extension));

// Muted by default: anything the host explained without ranking as an exception is a fact, not an alarm.
const tone = computed(() => (entry.state.variant === `danger` ? `text-danger` : entry.state.variant === `warning` ? `text-warning` : `text-muted`));

// How many places fit on a line before the column starts eating words rather than items.
const PLACES_SHOWN = 3;
// Ordered by facetsOf's visibility ranking.
const places = computed(() => entry.facets.filter((facet) => facet.surface).map((facet) => facet.label));
const shown = computed(() => places.value.slice(0, PLACES_SHOWN).join(` · `));
const hidden = computed(() => places.value.slice(PLACES_SHOWN));
</script>

<template>
    <!-- The headline is one button and the switch sits outside it, so pressing the switch never also opens the page. -->
    <Row class="@container" header-button interactive chevron @header-click="emit(`open`)" @click="emit(`open`)">
        <template #lead="{ mark }">
            <!-- Dimmed and desaturated when off, so the mark goes quiet with the rest of the row. -->
            <BrandMark
                plain
                :size="mark"
                :name="manifest.name"
                :art="manifest.art"
                :logo="manifest.logo"
                :icon="manifest.icon"
                :idle="!entry.extension.enabled"
            />
        </template>

        <template #title>
            <span class="flex min-w-0 items-baseline gap-3">
                <!-- Dimming never touches the switch, the one control that still does something on an off row. -->
                <span class="min-w-0 flex-1 truncate font-normal @2xl:w-48 @2xl:flex-none">
                    <span v-if="entry.extension.source !== `builtin`" class="text-subtle">{{ manifest.publisher }}.</span
                    ><span class="font-medium" :class="entry.extension.enabled ? `text-content` : `text-muted`">{{ manifest.name }}</span>
                </span>
                <span
                    class="hidden min-w-0 flex-1 items-baseline gap-1.5 text-xs font-normal @2xl:flex"
                    :class="entry.extension.enabled ? `text-muted` : `text-subtle`"
                >
                    <span v-tooltip.overflow="shown" class="min-w-0 truncate">{{ shown }}</span>
                    <span v-if="hidden.length > 0" v-tooltip.top="hidden.join(` · `)" class="shrink-0 text-subtle">+{{ hidden.length }}</span>
                </span>
            </span>
        </template>

        <template v-if="entry.detail || devLine" #description>
            <span v-if="entry.detail" class="block truncate" :class="tone">{{ entry.detail }}</span>
            <span v-else class="block truncate" :class="entry.extension.dev?.held === undefined ? `text-muted` : `text-warning`">{{ devLine }}</span>
        </template>

        <!-- Facts, not controls: the update on offer (security fixes in the loud tier), then the host's state where it has one. -->
        <template v-if="entry.extension.update !== undefined || entry.state.label !== undefined" #meta>
            <StatusBadge
                v-if="!entry.state.attention && entry.extension.update !== undefined"
                v-tooltip.top="t(`sandbox.extensionRow.reviewUpdate`)"
                :variant="entry.extension.update.securityFix ? `danger` : `info`"
                :label="entry.extension.update.securityFix ? t(`sandbox.extensionRow.securityUpdate`) : t(`sandbox.extensionRow.update`)"
                size="xs"
            />
            <StatusBadge v-if="entry.state.badge" :variant="entry.state.variant" :label="entry.state.label" size="xs" />
            <span v-else-if="entry.state.label !== undefined">{{ entry.state.label }}</span>
        </template>

        <template #control>
            <ExtensionSwitch :extension="entry.extension" :pending="pending" @toggle="(enabled) => emit(`toggle`, enabled)" />
        </template>
    </Row>
</template>
