<!--
    Every notice a view has, ranked and de-duplicated (notice.ts), in one place. Pass a plain list including `undefined`s; renders nothing when
    nothing is wrong.
-->
<script setup lang="ts">
import { computed } from "vue";
import Notice from "./Notice.vue";
import { type NoticeModel, noticeKey, rankNotices } from "./notice.js";

const { of, dismissLabel = `` } = defineProps<{ of: readonly (NoticeModel | undefined)[]; dismissLabel?: string }>();
const emit = defineEmits<{ dismiss: [notice: NoticeModel] }>();

const ranked = computed(() => rankNotices(of.filter((notice) => notice !== undefined)));
</script>

<template>
    <div v-if="ranked.length > 0" class="flex flex-col gap-2">
        <Notice v-for="notice in ranked" :key="noticeKey(notice)" :of="notice" :dismiss-label="dismissLabel" @dismiss="emit(`dismiss`, notice)" />
    </div>
</template>
