<!-- The home read through one file name: the current folder's copy of it, in place of the folder's tiles. -->
<script setup lang="ts">
import { basename } from "@intentic/ui/path";
import { computed } from "vue";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { workspaceDir } from "../health/workspaceScope";
import { useCover } from "./useCover";
import { useHome } from "./useHome";
import HomeCoverDocument from "./HomeCoverDocument.vue";

// Drawn by HomeView in place of its tiles while a cover is chosen. There is no navigation here: the explorer tree is the
// navigator, listing folders alone and marking the ones that hold the file, and whatever folder it lands on is the home's
// folder (useHome), so this page follows the tree, the breadcrumb and the links below alike.

const { name, rootLabel } = defineProps<{ name: string; rootLabel: string }>();
const emit = defineEmits<{ reveal: [folder: string]; exit: [] }>();

const { homeDir } = useHome();
const { listingOf } = useWorkspaceTree();
const { coverOf, below: coversBelow } = useCover(() => name);

const listing = computed(() => listingOf(homeDir.value));
const entry = computed(() => (listing.value === undefined ? undefined : coverOf(listing.value)));
const here = computed(() => (homeDir.value === workspaceDir.value ? rootLabel : basename(homeDir.value)));

// Nearest first, named from the folder being read, so the list reads as the way down from here.
const BELOW = 6;
const below = computed(() =>
    coversBelow(homeDir.value, BELOW).map((path) => ({
        path,
        label: homeDir.value === `` ? path : path.slice(homeDir.value.length + 1),
    })),
);
</script>

<template>
    <HomeCoverDocument
        :folder="homeDir"
        :here="here"
        :name="name"
        :entry="entry"
        :listed="listing !== undefined"
        :below="below"
        @reveal="emit(`reveal`, $event)"
        @exit="emit(`exit`)"
    />
</template>
