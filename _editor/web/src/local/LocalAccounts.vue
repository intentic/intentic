<!-- The LOCAL posture's accounts window: the Agent tab of the sandbox hub, standing alone. Everything about
     the AI the engine signs in as — provider accounts, connect flows, usage — is that one component; this
     wrapper only gives it the page scroll and gutter the hub's layout used to provide. -->
<script setup lang="ts">
import SandboxAgent from "../pages/sandbox/SandboxAgent.vue";
</script>

<template>
    <div class="h-full w-full overflow-y-auto">
        <div class="mx-auto max-w-3xl px-4 py-6">
            <SandboxAgent />
        </div>
    </div>
</template>
