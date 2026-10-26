<script setup lang="ts">
import { Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { builtInPersonaViews } from "../../../models/sandbox/personas/builtInPersonas";

// The two personas every sandbox has, above the ones it was given: Full access and No accounts. Shown read-only (no
// remove, no editor: they are always there), each with what it reaches and when it is worn without being picked, so
// "who does this run act as" always has an answer on this page, even for a chat or an automation that picked no one.

const t = useT();
const builtIns = builtInPersonaViews();
</script>

<template>
    <RowGroup :label="t(`sandbox.builtInPersonas.title`)">
        <RowNote variant="block">{{ t(`sandbox.accessProfiles.posture`) }}</RowNote>
        <Row v-for="persona in builtIns" :key="persona.id" :icon="persona.icon" :title="persona.label" :description="`${persona.note} ${persona.when}`" />
    </RowGroup>
</template>
