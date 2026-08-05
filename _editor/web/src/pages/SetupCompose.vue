<script setup lang="ts">
import { Code, useDevice } from "@intentic/ui";
import { computed } from "vue";
import type { ComposeArgs } from "./setupCompose";
import { composeBootstrap, composeFile } from "./setupCompose";

/* The "Docker Compose" tab of setup's Run step: the same sandbox + tunnel connect.sh starts, declared as two
 * services the user pastes into their own docker-compose.yml, plus the one-time bootstrap that turns the
 * setup code into the compose .env. Same container/volume/network names as the script, so the workspace data
 * and cleanup keep working whichever way the sandbox is managed. */

const props = defineProps<{ args: ComposeArgs }>();
// Forty-odd lines of YAML is a file to paste into an editor, not something anyone reads down a phone — on a
// phone it is clamped to a glimpse of what it declares, with the copy button (and "Show all") right there.
const { mobile } = useDevice();

const yaml = computed(() => composeFile(props.args));
const bootstrap = computed(() => composeBootstrap(props.args));
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- What this tab is actually FOR, said before the YAML rather than left to be inferred from it: it is
             the path for someone who would rather read a file than run a script, and that is not something the
             label "Docker Compose" conveys to the person looking for exactly it. -->
        <p class="flex items-start gap-2 text-2xs text-muted">
            <Icon name="eye" class="mt-0.5 shrink-0 text-subtle" />
            <span class="min-w-0">No script runs on your machine — you read the file below in full, then start it yourself.</span>
        </p>
        <Code :code="yaml" lang="yaml" label="1. Add these services to your docker-compose.yml" :wrap="false" :clamp-lines="mobile ? 8 : undefined" />
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
            The first command redeems your setup code into a <code>.env</code> compose reads — run it once; after that the sandbox is yours to manage
            with <code>docker compose</code> (<code>up -d</code>, <code>down</code>, <code>logs</code>). Your workspace lives in the named volumes, so
            <code>down</code>/<code>up</code> keeps it.
        </p>
        <p class="text-xs text-muted">
            Desktop sync isn't part of the compose path — once your workspace opens, enable it from its <b>Desktop sync</b> card.
        </p>
        <p v-if="args.platformUrl" class="flex items-start gap-2 text-xs text-warning">
            <Icon name="box" class="mt-0.5 shrink-0" />
            <!-- min-w-0 + break-words: the image reference is one unbreakable token wider than a phone, and a
                 flex child defaults to min-content width, so without both it pushes the card's text off-screen. -->
            <span class="min-w-0 break-words"
                >Local dev: compose pulls the <b>published</b> <code>{{ args.image }}</code> (not your local checkout — compose can't rebuild), and
                its <code>PLATFORM_URL</code> points at your machine, so run it here on the same machine as your dev platform. To deploy to a real
                environment, generate this from that environment's platform instead.</span
            >
        </p>
    </div>
</template>
