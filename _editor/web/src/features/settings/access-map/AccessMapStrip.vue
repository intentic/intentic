<script setup lang="ts">
import { Icon, SandboxLogo, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { GraphEdge, GraphSandbox } from "./accountGraph";
import { groupLabel, slotLabel, stripNameLabel, tieSaid } from "./accessMapWords";
import type { TieVerb } from "./ties";
import { type StripGroupKey, type StripSlot, stripOf } from "./tieStrip";

// ONE TIE AS A ROW OF GLYPHS: what it lets its holder do, each switch in its own place, lit when on and faint when off,
// then the names no glyph can say (a role, a service, an account) and how many other people's agents may use it too.
// Pointing at a glyph names it; a screen reader hears the whole tie in words. The sandbox it comes from leads the row
// where the row could be read as someone else's.

const t = useT();

const {
    edge,
    verb,
    from,
    dim = false,
} = defineProps<{
    edge: GraphEdge;
    /** How the tie reads from where it is drawn, for the words a screen reader hears. */
    verb: TieVerb;
    /** The sandbox the tie starts from, shown first: where more than one tie lands on one card, or a link lands. */
    from?: GraphSandbox | undefined;
    /** Out of the focus's reach while something else on the same card is in it. */
    dim?: boolean;
}>();

const strip = computed(() => stripOf(edge));

// Who a group speaks for, drawn before it: a computer's switches for agents and for people share some glyphs.
const markOf = (key: StripGroupKey): `robot` | `users` | undefined => (key === `agents` ? `robot` : key === `people` ? `users` : undefined);

const slotTip = (slot: StripSlot): Tip => ({
    title: slotLabel(slot.key),
    tone: slot.on ? `success` : undefined,
    note: slot.on ? undefined : t(`settings.accessMap.glyph.off`),
});

const othersTip = computed(
    (): Tip => ({
        title: t(`settings.accessMap.glyph.othersTitle`),
        note: t(`settings.accessMap.glyph.othersNote`, { count: strip.value?.others ?? 0 }, strip.value?.others ?? 0),
    }),
);

const said = computed(() => [from?.name, tieSaid(edge, verb)].filter((part) => part !== undefined && part !== ``).join(`: `));
</script>

<template>
    <span
        v-if="strip !== undefined"
        role="img"
        :aria-label="said"
        class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs transition-opacity"
        :class="dim ? `opacity-35` : strip.yours ? `` : `opacity-60`"
    >
        <SandboxLogo v-if="from !== undefined" v-tooltip.top="from.name" :size="14" :image="from.image ?? null" :name="from.name" class="shrink-0 rounded-sm" />
        <span v-if="strip.answer === `revoked`" class="text-2xs text-muted line-through">{{ t(`settings.accessMap.glyph.revoked`) }}</span>
        <template v-else>
            <span v-for="group in strip.groups" :key="group.key" class="flex shrink-0 items-center">
                <Icon v-if="markOf(group.key) !== undefined" v-tooltip.top="groupLabel(group.key)" :name="markOf(group.key) ?? `robot`" class="mr-1 text-subtle" />
                <span
                    v-for="slot in group.slots"
                    :key="slot.key"
                    v-tooltip.top="slotTip(slot)"
                    class="flex size-4 items-center justify-center"
                    :class="slot.on ? `text-content` : `text-subtle opacity-35`"
                >
                    <Icon :name="slot.icon" />
                </span>
            </span>
            <span v-for="name in strip.names" :key="name.key" v-tooltip.top="stripNameLabel(name.key)" class="flex min-w-0 items-center gap-1 text-2xs text-muted">
                <Icon :name="name.icon" class="shrink-0" /><span class="truncate">{{ name.name }}</span>
            </span>
            <span v-if="strip.admin" v-tooltip.top="t(`settings.accessMap.glyph.adminPassword`)" class="flex size-4 shrink-0 items-center justify-center text-content">
                <Icon name="key" />
            </span>
            <span v-if="strip.answer === `silent`" class="shrink-0 text-2xs text-subtle">{{ t(`settings.accessMap.state.unreachable`) }}</span>
        </template>
        <span v-if="strip.others > 0" v-tooltip.top="othersTip" class="shrink-0 text-2xs tabular-nums text-muted">+{{ strip.others }}</span>
    </span>
</template>
