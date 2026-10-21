<!-- WHAT A REMOVAL CUTS, drawn rather than said: who uses the sandbox, the sandbox, and the machine that runs it, joined by
     the links the press keeps or cuts. Three words under three marks are read at a glance where the same facts in a
     paragraph were not read at all; ticking "also delete it there" in the dialog cuts the second link live. -->
<script setup lang="ts">
import { toneInk, toneRim, toneWash } from "@intentic/ui";
import type { RemovalPicture } from "./removalMap";

const { picture } = defineProps<{ picture: RemovalPicture }>();
</script>

<template>
    <figure
        :aria-label="picture.label"
        class="grid grid-cols-[minmax(0,3fr)_minmax(1.25rem,1fr)_minmax(0,3fr)_minmax(1.25rem,1fr)_minmax(0,3fr)] items-start py-1"
    >
        <template v-for="(node, index) in picture.nodes" :key="index">
            <div class="flex min-w-0 flex-col items-center gap-1.5 text-center">
                <span :class="toneWash(node.lost ? `danger` : `neutral`, `grid size-11 place-items-center rounded-full text-lg transition-colors`)">
                    <Icon :name="node.icon" />
                </span>
                <span class="w-full truncate text-sm font-medium text-content" :title="node.label">{{ node.label }}</span>
                <span :class="toneInk(node.lost ? `danger` : `neutral`, `-mt-1 text-xs leading-tight transition-colors`)">{{ node.fate }}</span>
            </div>
            <!-- The link to the next mark, at the marks' centre line: whole, or dashed and crossed through. -->
            <div v-if="index < 2" class="relative mt-[1.375rem] flex h-0 items-center" aria-hidden="true">
                <span
                    class="w-full border-t-2 transition-colors"
                    :class="picture.cuts[index] ? toneRim(`danger`, `strong`, `border-dashed`) : toneRim(`neutral`, `strong`, `border-solid`)"
                />
                <span
                    v-if="picture.cuts[index]"
                    :class="toneWash(`danger`, `absolute left-1/2 grid size-5 -translate-x-1/2 place-items-center rounded-full text-2xs`)"
                >
                    <Icon name="times" />
                </span>
            </div>
        </template>
    </figure>
</template>
