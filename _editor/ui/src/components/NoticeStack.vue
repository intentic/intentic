<!-- EVERY NOTICE A VIEW HAS, IN ONE PLACE, IN THE RIGHT ORDER (ranking and de-duplication: notice.ts).
     A view hands this everything currently wrong — `undefined`s included, so call sites stay a plain list
     rather than a filter — and renders nothing at all when nothing is. Safe to leave mounted at the top of a
     view, which is the point: the alternative is a `v-if` box per failure scattered down the template, where
     two problems at once produce two boxes with no relationship and the user reads them in markup order. -->
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
