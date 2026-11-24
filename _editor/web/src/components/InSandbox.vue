<!-- Everything inside speaks of one sandbox: provides its scope (client/sandbox/scope/useSandboxScope.ts) to the slot, so a
     composable that takes `useSandboxScope()` reads and writes that sandbox instead of the active one. Renders nothing
     of its own. -->
<script setup lang="ts">
import { provideSandboxScope } from "../client/sandbox/scope/useSandboxScope";

const props = defineProps<{
    /** The sandbox the slot speaks of; undefined, the active one. */
    sandboxId: string | undefined;
}>();

provideSandboxScope(() => props.sandboxId);
</script>

<template>
    <slot />
</template>
