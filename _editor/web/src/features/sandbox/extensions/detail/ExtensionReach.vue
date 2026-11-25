<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { Button, formatCount, type IconName, InfoHint, Row, RowGroup, RowNote } from "@intentic/ui";
import { computed } from "vue";
import { startAgent } from "../../../../models/fleet/agentActions";
import { tightenBrief } from "../../../../models/sandbox/extensionBrief";
import type { ExtensionEntry } from "../../../extensions/useExtensionList";
import { routesOf } from "./extensionRoutes";
import { useT } from "@intentic/ui/i18n";

// The sandbox reach approved at install, one route a line: what it reads, what it changes, and how often it has done
// either, from a per-route call ledger. A route never called reads quieter, as declared rather than guessed unneeded;
// why that is not a verdict waits behind the header's (i). With no observations yet (just installed, or never opened),
// every route reads as declared.

const t = useT();

const { entry } = defineProps<{ entry: ExtensionEntry }>();

const routes = computed(() => routesOf(entry.extension));
const observed = computed(() => entry.extension.usage !== undefined);
const anyUnused = computed(() => routes.value.some((route) => route.unused));

// A read only looks; anything else may change what it touches. A route with no method is either.
const READS = new Set([`GET`, `HEAD`]);
const iconOf = (method: string): IconName => (method === `` ? `arrows-h` : READS.has(method) ? `eye` : `pencil`);
const verbOf = (method: string): string => {
    if (method === ``) {
        return t(`sandbox.extensionRow.routeAny`);
    }
    return `${READS.has(method) ? t(`sandbox.extensionRow.routeReads`) : t(`sandbox.extensionRow.routeChanges`)} · ${method}`;
};

// Only for a workspace extension, whose manifest the owner can actually edit; needs at least one route used and one
// never called, so there's something to act on.
const tightenable = computed(
    () => entry.extension.source === `workspace` && observed.value && anyUnused.value && routes.value.some((route) => route.calls > 0),
);
const tighten = (): void => {
    const manifest = entry.extension.manifest;
    startAgent(
        tightenBrief({
            id: extensionIdOf(manifest),
            // A workspace extension's name is its directory (one per subdirectory), so no round trip is needed.
            dir: `.intentic/config/workspace-extensions/${manifest.name}`,
            unused: routes.value.filter((route) => route.unused).map((route) => route.route),
            used: routes.value.filter((route) => route.calls > 0).map(({ route, calls }) => ({ route, calls })),
        }),
    );
};
</script>

<template>
    <RowGroup v-if="routes.length > 0" id="extension-reach" :label="t(`sandbox.extensionRow.sandboxAccess`)">
        <template v-if="anyUnused" #info>
            <InfoHint :label="t(`sandbox.extensionRow.neverCalledWhyLabel`)">
                <span class="block text-xs text-content">{{ t(`sandbox.extensionRow.neverCalledWhy`) }}</span>
            </InfoHint>
        </template>
        <!-- Maintainer-owned extensions route review to the owner. -->
        <template v-if="tightenable" #actions>
            <Button size="small" tier="boring" :label="t(`sandbox.extensionRow.agentGoThrough`)" @click="tighten">
                <template #icon><Icon name="sparkles" /></template>
            </Button>
        </template>
        <Row v-for="route in routes" :key="route.route" :icon="iconOf(route.method)" :description="verbOf(route.method)">
            <template #title>
                <span class="block truncate font-mono text-xs" :class="route.unused ? `text-subtle` : `text-content`">{{ route.path }}</span>
            </template>
            <template v-if="observed" #meta>
                <span v-if="route.calls > 0">{{ t(`sandbox.extensionRow.callCount`, { count: formatCount(route.calls) }, route.calls) }}</span>
                <span v-else>{{ t(`sandbox.extensionRow.neverCalled`) }}</span>
            </template>
        </Row>
        <RowNote v-if="!observed">{{ t(`sandbox.extensionRow.notObservedYet`) }}</RowNote>
    </RowGroup>
</template>
