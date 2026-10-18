<script setup lang="ts">
import { Avatar, BrandMark, Icon, PersonaFace, ui } from "@intentic/ui";
import { formatList } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import { identityHue } from "../../../lib/identityHue";
import { editPath, editWords, GROUP_ICONS, groupLabel, isGround, nodeDetail, nodeLabel, type PersonaName, principalLine } from "./mapWords";
import { bundleId, type Focus, type Lighting } from "./reachLighting";
import type { MapNode, Principal, ReachMap } from "./reachModel";

// WHAT THE MAP IS SAYING RIGHT NOW, IN ONE LINE. Lines and edges show a reach; this says it, so nobody has to count them
// to know that Jo sees the whole workspace and acts only through Maya, or that nothing that gets in reaches the VPN. With
// nothing in focus it says how to read the map. One line high whatever it says, so a focus never moves the map under the
// pointer; what does not fit is in its tooltip, and the group blocks carry the counts.

const t = useT();

const { map, focus, lighting, pinned, personaName } = defineProps<{
    map: ReachMap;
    focus: Focus | undefined;
    lighting: Lighting | undefined;
    pinned: boolean;
    personaName: PersonaName;
}>();
defineEmits<{ clear: [] }>();

const areasExist = computed(() => map.areas.length > 1);
const principal = computed(() => (focus?.kind === `principal` ? map.principals.find((entry) => entry.id === focus.id) : undefined));
const node = computed(() => (focus?.kind === `node` ? map.nodes.get(focus.id) : undefined));
// A folded block in focus: a group, or the box's secrets.
const bundle = computed(() => {
    if (focus?.kind !== `node` || !focus.id.startsWith(`bundle:`)) {
        return undefined;
    }
    if (focus.id === bundleId(`secrets`)) {
        return { label: t(`sandbox.sandboxMap.secrets`), icon: `key` as const, count: map.secrets.length };
    }
    const group = map.groups.find((entry) => bundleId(entry.key) === focus.id);
    return group === undefined ? undefined : { label: groupLabel(group.key), icon: GROUP_ICONS[group.key], count: group.nodes.length };
});

const wholeWorkspace = (who: Principal, how: `edit` | `see`): boolean =>
    map.areas.every((ground) => who.reach.get(ground.id) === how || (how === `see` && who.reach.get(ground.id) === `edit`));

// Where a principal works: the whole workspace, the areas they edit and the ones they only read, or none.
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

const summary = computed(() => {
    const who = principal.value;
    if (who === undefined) {
        return ``;
    }
    const through = throughLine(who);
    return through === undefined ? workspaceLine(who) : `${workspaceLine(who)}. ${through}`;
});

// Who reaches the focused thing, as the lighting already worked it out.
const holders = computed(() => map.principals.filter((entry) => lighting?.principals.has(entry.id) === true));
const holderLine = computed(() => {
    if (holders.value.length === 0) {
        return t(`sandbox.sandboxMap.reachedByNobody`);
    }
    const names = formatList(holders.value.map((who) => (who.self === true ? t(`sandbox.sandboxMap.you`) : who.label)));
    const counts = { count: holders.value.length, total: map.principals.length, names };
    return bundle.value === undefined ? t(`sandbox.sandboxMap.reachedBy`, counts) : t(`sandbox.sandboxMap.reachedInBundle`, counts);
});
const nodePath = computed(() => (node.value === undefined ? undefined : editPath(node.value)));
const markOf = (entry: MapNode): string => entry.icon ?? `folder`;
</script>

<template>
    <div class="flex h-9 min-w-0 flex-1 items-center gap-2.5" aria-live="polite">
        <template v-if="principal !== undefined">
            <Avatar v-if="principal.kind === `person`" :size="20" :name="principal.label" :hue="identityHue(principal.label)" />
            <span v-else class="flex size-5 shrink-0 items-center justify-center rounded-md bg-overlay text-2xs text-muted"
                ><Icon :name="principal.kind === `token` ? `key` : `link`"
            /></span>
            <span class="max-w-64 shrink-0 truncate text-sm font-medium text-content">{{ principal.label }}</span>
            <span class="shrink-0 text-xs text-muted">{{ principalLine(principal, personaName) }}</span>
            <span class="min-w-0 truncate text-xs text-subtle" :title="summary">{{ summary }}</span>
            <RouterLink to="/sandbox/access" :class="ui.textButton()" class="ml-auto shrink-0">{{ t(`sandbox.sandboxMap.changeAccess`) }}</RouterLink>
        </template>

        <template v-else-if="bundle !== undefined">
            <span class="flex size-5 shrink-0 items-center justify-center rounded-md bg-overlay text-2xs text-muted"><Icon :name="bundle.icon" /></span>
            <span class="shrink-0 text-sm font-medium text-content">{{ bundle.label }}</span>
            <span class="shrink-0 text-xs tabular-nums text-muted">{{ bundle.count }}</span>
            <span class="min-w-0 truncate text-xs text-subtle" :title="holderLine">{{ holderLine }}</span>
        </template>

        <template v-else-if="node !== undefined">
            <PersonaFace v-if="node.kind === `persona`" :persona="{ id: node.ref ?? node.id, label: node.label }" :size="20" />
            <span v-else-if="node.kind === `model` && node.provider !== undefined" class="flex size-5 shrink-0 items-center justify-center text-sm text-content">
                <ProviderLogo :provider="node.provider" />
            </span>
            <BrandMark v-else :size="20" :name="nodeLabel(node, areasExist)" :logo="node.logo" :icon="markOf(node)" />
            <span class="max-w-64 shrink-0 truncate text-sm font-medium text-content">{{ nodeLabel(node, areasExist) }}</span>
            <span v-if="node.state ?? nodeDetail(node)" class="max-w-48 shrink-0 truncate text-xs text-muted">{{ node.state ?? nodeDetail(node) }}</span>
            <span class="min-w-0 truncate text-xs text-subtle" :title="holderLine">{{ holderLine }}</span>
            <RouterLink v-if="nodePath !== undefined" :to="nodePath" :class="ui.textButton()" class="ml-auto shrink-0">{{ editWords(node) }}</RouterLink>
        </template>

        <span v-else class="flex min-w-0 items-center gap-2 text-xs text-muted">
            <Icon name="sitemap" class="shrink-0" />
            <span class="truncate">{{ t(`sandbox.sandboxMap.hint`) }}</span>
        </span>

        <button
            v-if="pinned"
            type="button"
            :class="ui.iconButton()"
            class="shrink-0"
            :aria-label="t(`sandbox.sandboxMap.clear`)"
            :title="t(`sandbox.sandboxMap.clear`)"
            @click="$emit(`clear`)"
        >
            <Icon name="times" />
        </button>
    </div>
</template>
