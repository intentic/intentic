<!-- One press that didn't work on a machine, and the line that does the same thing where nothing can refuse it. -->
<script setup lang="ts">
import { Code, Notice, type NoticeModel } from "@intentic/ui";

// Under the notice, not instead of it: what the machine said is the reason, and this is the way past it. Offered
// for every failure that has a line, since the usual reason a device press fails is a route to that machine this
// browser can't open — a switch it won't grant, an agent too old for the verb — and its own terminal is behind
// neither. Absent for an op whose command can't be typed from a standing start (one that redeems a token).
const { of, command, machine } = defineProps<{
    of: NoticeModel;
    command?: string;
    /** The machine's own name, so a page showing several says which terminal this goes into. */
    machine: string;
}>();
</script>

<template>
    <div class="flex flex-col gap-1.5">
        <Notice :of="of" />
        <!-- Wrapped: these are single long lines, and a horizontal scrollbar would hide the end of the one being offered. -->
        <Code v-if="command !== undefined" :code="command" lang="bash" :label="`Or run this on ${machine} yourself`" wrap />
    </div>
</template>
