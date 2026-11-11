<!-- A credential an agent asked the owner's computers for that nobody has answered yet, in the Secrets view's "Needs attention": where it is for, why, and where the answer waits. Answered in Passwords on that computer, which the row's link opens. -->
<script setup lang="ts">
import { BrandMark, Row } from "@intentic/ui";
import OpenInPasswords from "./OpenInPasswords.vue";
import type { WantRow } from "./secretWants";

const { want } = defineProps<{ want: WantRow }>();
</script>

<template>
    <Row :title="want.title" data-secret-want>
        <template #lead="{ mark }"><BrandMark plain :size="mark" :name="want.title" :icon="want.icon" /></template>
        <template #description>
            <span class="block truncate text-subtle">{{ want.detail }}</span>
            <span class="block truncate text-warning">{{ want.note }}</span>
        </template>
        <template #control><OpenInPasswords /></template>
    </Row>
</template>
