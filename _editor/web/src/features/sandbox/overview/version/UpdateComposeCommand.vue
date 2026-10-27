<!-- The update for a sandbox Docker Compose runs: Compose's own two steps, run where its file is. A command rather than
     a button, since nothing on this page reaches that machine (composeOffer.ts says when it is offered). -->
<script setup lang="ts">
import { COMPOSE_UPDATE_COMMAND } from "@intentic/sandbox-run";
import { useT } from "@intentic/ui/i18n";
import RunCommand from "../../../../components/RunCommand.vue";
import type { ComposeOffer } from "./composeOffer";

defineProps<{
    /** `known`: the sandbox says Compose runs it. `likely`: nothing says how it was started. */
    offer: ComposeOffer;
}>();

const t = useT();
</script>

<template>
    <RunCommand
        :command="COMPOSE_UPDATE_COMMAND"
        :explanation="offer === `known` ? t(`sandbox.sandboxUpdateCard.composeUpdateLead`) : t(`sandbox.sandboxUpdateCard.composeUpdateLikelyLead`)"
        :label="t(`sandbox.sandboxUpdateCard.composeUpdateLabel`)"
    />
</template>
