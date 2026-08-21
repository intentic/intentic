<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { environment } from "../environments/environment";
import { type ScriptSource, scriptSource } from "../environments/scriptCommand";

/* LOCAL DEV ONLY: which of the two script deliveries the command beside this one uses (see scriptCommand.ts).
 *
 * It sits on every command block that is READ here and PASTED somewhere else: a computer, a server, a laptop
 * being synced. Those are the ones the choice bites on: a dev build renders every script by repo path, which is
 * right when the command runs on the dev machine and simply cannot run anywhere else. The blocks whose command
 * is pasted on the machine the sandbox already runs on (a rebuild, a cleanup) don't carry it; they follow the
 * choice made here anyway, since the preference is one shared ref.
 *
 * A component rather than three copies of six lines, because a fourth command block would otherwise have to
 * guess the wording, the tone and whether the tooltip belongs on the pill or the label. Warning-toned and
 * prefixed like every other local-dev note in the app (setup's "builds from your checkout"): it is addressed to
 * whoever is developing intentic itself, and renders nothing at all for anyone else. */

const OPTIONS: { label: string; value: ScriptSource; title: string }[] = [
    { label: `Local`, value: `checkout`, title: `Runs the script from your checkout, only on a machine that has the repo` },
    { label: `Standard`, value: `published`, title: `Fetches the released script from intentic.dev, runs on any machine` },
];
</script>

<template>
    <div v-if="!environment.production" class="flex items-center gap-2 text-2xs text-warning">
        <span>Local dev: script source</span>
        <SegmentedControl v-model="scriptSource" :options="OPTIONS" size="xs" />
    </div>
</template>
