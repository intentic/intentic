<script setup lang="ts">
import { Code } from "@intentic-app/ui";
import { computed } from "vue";
import type { ComposeArgs } from "./setupCompose";
import { composeBootstrap, composeFile } from "./setupCompose";

/* The "Docker Compose" tab of setup's Run step: the same sandbox + tunnel connect.sh starts, declared as two
 * services the user pastes into their own docker-compose.yml, plus the one-time bootstrap that turns the
 * setup code into the compose .env. Same container/volume/network names as the script, so the workspace data
 * and cleanup keep working whichever way the sandbox is managed. */

const props = defineProps<{ args: ComposeArgs; syncEnabled: boolean }>();

const yaml = computed(() => composeFile(props.args));
const bootstrap = computed(() => composeBootstrap(props.args));
</script>

<template>
    <div class="flex flex-col gap-3">
        <Code :code="yaml" lang="yaml" label="1. Add these services to your docker-compose.yml" :wrap="false" />
        <Code
            :code="bootstrap"
            lang="bash"
            :label="
                args.mode === `own`
                    ? `2. In the same folder: claim your .env, add the Cloudflare token, mint the tunnel, start`
                    : `2. In the same folder: claim your .env, then start`
            "
            :wrap="true"
        />
        <p class="text-xs text-muted">
            The first command redeems your setup code into a <code>.env</code> compose reads — run it once; after that the sandbox is yours to
            manage with <code>docker compose</code> (<code>up -d</code>, <code>down</code>, <code>logs</code>). Your workspace lives in the named
            volumes, so <code>down</code>/<code>up</code> keeps it.
        </p>
        <p v-if="syncEnabled" class="text-xs text-muted">
            Desktop sync isn't part of the compose path — once your workspace opens, enable it from its <b>Desktop sync</b> card.
        </p>
        <p v-if="args.platformUrl" class="flex items-center gap-2 text-xs text-warning">
            <Icon name="box" class="shrink-0" />
            <span
                >Local dev: compose runs <code>{{ args.image }}</code> as-is and won't rebuild it from your checkout — build it first (run the
                Linux/macOS command once, or <code>pnpm dev:sandbox</code>).</span
            >
        </p>
    </div>
</template>
