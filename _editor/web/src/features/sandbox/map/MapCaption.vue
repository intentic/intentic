<script setup lang="ts">
import { Avatar, BrandMark, Icon, PersonaFace, ui } from "@intentic/ui";
import { formatList } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import { identityHue } from "../../../lib/identityHue";
import { editPath, editWords, groupLabel, isGround, nodeDetail, nodeLabel, type PersonaName, principalLine } from "./mapWords";
import { type Focus, holdersOf, type MapNode, type Principal, type ReachMap, reachedIn } from "./reachModel";

// WHAT THE MAP IS SAYING RIGHT NOW, IN WORDS. Lines and rings show a reach; this says it, so nobody has to count rings
// to know that Jo's agents may spend two of nine connections, or that nothing that gets in reaches the VPN. With nothing
// in focus it says how to read the map. It stands above the stage and stays put while the stage scrolls.

const t = useT();

const { map, focus, pinned, personaName } = defineProps<{
    map: ReachMap;
    focus: Focus | undefined;
    pinned: boolean;
    personaName: PersonaName;
}>();
defineEmits<{ clear: [] }>();

const areasExist = computed(() => map.areas.length > 1);
const principal = computed(() => (focus?.kind === `principal` ? map.principals.find((entry) => entry.id === focus.id) : undefined));
const node = computed(() => (focus?.kind === `node` ? map.nodes.get(focus.id) : undefined));

const wholeWorkspace = (who: Principal, how: `edit` | `see`): boolean => map.areas.every((ground) => who.reach.get(ground.id) === how || (how === `see` && who.reach.get(ground.id) === `edit`));

// Where a principal works, in one line: the whole workspace, the areas they edit and the ones they only read, or none.
const workspaceLine = (who: Principal): string => {
    if (wholeWorkspace(who, `edit`)) {
        return t(`sandbox.sandboxMap.editsAll`);
    }
    if (wholeWorkspace(who, `see`) && !map.areas.some((ground) => who.reach.get(ground.id) === `edit`)) {
        return t(`sandbox.sandboxMap.seesAll`);
    }
    const names = (how: `edit` | `see`): string[] =>
        map.areas.filter((ground) => who.reach.get(ground.id) === how).map((ground) => nodeLabel(ground, areasExist.value));
    const parts = [
        ...(names(`edit`).length > 0 ? [t(`sandbox.sandboxMap.editsAreas`, { areas: formatList(names(`edit`)) })] : []),
        ...(names(`see`).length > 0 ? [t(`sandbox.sandboxMap.seesAreas`, { areas: formatList(names(`see`)) })] : []),
    ];
    return parts.length === 0 ? t(`sandbox.sandboxMap.seesNothing`) : parts.join(`. `);
};

// The narrowing a principal's outward reach comes with, if any.
const throughLine = (who: Principal): string | undefined => {
    const outward = [...who.reach.entries()].filter(([id]) => !isGround(id) && !id.startsWith(`persona:`));
    if (who.status === `inert`) {
        return undefined;
    }
    if (outward.length === 0) {
        return t(`sandbox.sandboxMap.noAgents`);
    }
    if (who.kind === `token` && who.scope === `editor`) {
        return t(`sandbox.sandboxMap.oneConversation`);
    }
    if (who.kind === `link` && who.actsAs === undefined) {
        return t(`sandbox.sandboxMap.noAccounts`);
    }
    if (!outward.some(([, how]) => how === `through`)) {
        return undefined;
    }
    const worn = map.personas.filter((card) => who.reach.has(card.id)).map((card) => card.label);
    return t(`sandbox.sandboxMap.onlyThrough`, { personas: formatList(worn) });
};

const tallies = computed(() => {
    const who = principal.value;
    return who === undefined ? [] : map.groups.map((group) => ({ key: group.key, label: groupLabel(group.key), lit: reachedIn(who, group.nodes), total: group.nodes.length }));
});
const thingCount = computed(() => map.groups.reduce((sum, group) => sum + group.nodes.length, 0));

const holders = computed(() => (node.value === undefined ? [] : holdersOf(map, node.value.id)));
const holderNames = computed(() => holders.value.map(({ principal: who }) => (who.self === true ? t(`sandbox.sandboxMap.you`) : who.label)));
const nodePath = computed(() => (node.value === undefined ? undefined : editPath(node.value)));
const markOf = (entry: MapNode): string => entry.icon ?? `folder`;
</script>

<template>
    <!-- As tall as its fullest state (a name, a line and a row of tallies), so focusing something never moves the map under the pointer. -->
    <div class="flex min-h-24 items-start gap-3 rounded-xl border border-line-subtle bg-card px-4 py-3" aria-live="polite">
        <template v-if="principal !== undefined">
            <Avatar v-if="principal.kind === `person`" :size="32" :name="principal.label" :hue="identityHue(principal.label)" />
            <span v-else class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-overlay text-base text-muted">
                <Icon :name="principal.kind === `token` ? `key` : `link`" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span class="truncate text-sm font-semibold text-content">{{ principal.label }}</span>
                    <span class="text-xs text-muted">{{ principalLine(principal, personaName) }}</span>
                </div>
                <p class="text-xs text-muted">
                    {{ workspaceLine(principal) }}<template v-if="throughLine(principal) !== undefined">. {{ throughLine(principal) }}</template>
                </p>
                <div v-if="tallies.length > 0" class="flex flex-wrap gap-1.5">
                    <span
                        v-for="tally in tallies"
                        :key="tally.key"
                        class="rounded-md px-1.5 py-0.5 text-2xs tabular-nums"
                        :class="tally.lit > 0 ? `text-content ring-1 ring-(--map-ink)` : `text-faint ring-1 ring-line-subtle`"
                    >
                        {{ tally.label }} {{ t(`sandbox.sandboxMap.litOf`, { lit: tally.lit, total: tally.total }) }}
                    </span>
                </div>
            </div>
            <RouterLink to="/sandbox/access" :class="ui.textButton()" class="shrink-0">{{ t(`sandbox.sandboxMap.changeAccess`) }}</RouterLink>
        </template>

        <template v-else-if="node !== undefined">
            <PersonaFace v-if="node.kind === `persona`" :persona="{ id: node.ref ?? node.id, label: node.label }" :size="32" />
            <span v-else-if="node.kind === `model` && node.provider !== undefined" class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-overlay text-base text-content">
                <ProviderLogo :provider="node.provider" />
            </span>
            <BrandMark v-else :size="32" :name="nodeLabel(node, areasExist)" :logo="node.logo" :icon="markOf(node)" />
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span class="truncate text-sm font-semibold text-content">{{ nodeLabel(node, areasExist) }}</span>
                    <span v-if="node.state ?? nodeDetail(node)" class="truncate text-xs text-muted">{{ node.state ?? nodeDetail(node) }}</span>
                </div>
                <p class="text-xs text-muted">
                    {{
                        holders.length === 0
                            ? t(`sandbox.sandboxMap.reachedByNobody`)
                            : t(`sandbox.sandboxMap.reachedBy`, { count: holders.length, total: map.principals.length, names: formatList(holderNames) })
                    }}
                </p>
            </div>
            <RouterLink v-if="nodePath !== undefined" :to="nodePath" :class="ui.textButton()" class="shrink-0">{{ editWords(node) }}</RouterLink>
        </template>

        <template v-else>
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-overlay text-base text-muted"><Icon name="sitemap" /></span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-sm font-medium text-content">{{
                    t(`sandbox.sandboxMap.summary`, {
                        ways: t(`sandbox.sandboxMap.waysIn`, { count: map.principals.length }, map.principals.length),
                        things: t(`sandbox.sandboxMap.thingsReached`, { count: thingCount }, thingCount),
                    })
                }}</span>
                <span class="text-xs text-muted">{{ t(`sandbox.sandboxMap.hint`) }}</span>
            </div>
        </template>

        <button v-if="pinned" type="button" :class="ui.iconButton()" class="-mr-1.5 -mt-1 shrink-0" :aria-label="t(`sandbox.sandboxMap.clear`)" :title="t(`sandbox.sandboxMap.clear`)" @click="$emit(`clear`)">
            <Icon name="times" />
        </button>
    </div>
</template>
