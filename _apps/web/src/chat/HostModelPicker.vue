<script setup lang="ts">
import { AnchoredOverlay, BottomSheet, useDevice } from "@intentic/ui";
import { computed } from "vue";
import { modelRequest, settleModelPick } from "../composables/chat/hostModelPicker";
import type { PickerEntry } from "../composables/chat/modelPicker";
import ModelPicker from "./ModelPicker.vue";

/* The app-global mount for the shell's own model picker when something outside the chat asks for one
 * (hostModelPicker.ts — today, an extension calling `api.models.pick()`). Mounted in App.vue rather than in a
 * shell, because the two shells would otherwise each need their own copy and neither is the natural owner: the
 * picker belongs to nothing on screen, it belongs to whoever asked.
 *
 * Same body as the composer's, in the same two hosts: an anchored popover on desktop, a sheet on mobile.
 *
 * THE HOSTS STAY MOUNTED and `open` drives them — the arrangement ChatPanel already uses, and not an incidental
 * one. AnchoredOverlay measures and places its box in a watcher on `open` that is deliberately NOT immediate
 * (there is nothing to measure until the box has rendered), so a host mounted with `open` already true never
 * places at all: the panel stays parked at its off-screen measuring position, open and invisible. Only the BODY
 * is conditional, which is what still gives it a per-open remount — the reset query and the catalog refresh
 * ModelPicker relies on. */

const { mobile } = useDevice();

// One boolean over the request, so both hosts' own dismissal (pointerdown outside, Escape, the sheet's
// backdrop) settles the promise as a dismissal rather than silently orphaning it.
const open = computed<boolean>({
    get: () => modelRequest.value !== undefined,
    set: (value) => {
        if (!value) {
            settleModelPick(undefined);
        }
    },
});

const choose = (entry: PickerEntry): void => settleModelPick({ provider: entry.provider, model: entry.value, label: entry.label });
</script>

<template>
    <BottomSheet v-if="mobile" v-model="open" header="Model">
        <ModelPicker v-if="modelRequest" :provider="modelRequest.provider" :model="modelRequest.model" @pick="choose" @close="settleModelPick()" />
    </BottomSheet>
    <AnchoredOverlay v-else v-model="open" :anchor="modelRequest?.anchor">
        <div class="flex min-h-0 w-[26rem] flex-col">
            <ModelPicker
                v-if="modelRequest"
                :provider="modelRequest.provider"
                :model="modelRequest.model"
                @pick="choose"
                @close="settleModelPick()"
            />
        </div>
    </AnchoredOverlay>
</template>
