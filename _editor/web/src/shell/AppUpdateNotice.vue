<script setup lang="ts">
import Button from "primevue/button";
import { useAppUpdate } from "../composables/appUpdate";

/* THERE IS A NEWER INTENTIC — the whole of what this app says about its own version, in one line.
 *
 * TWO CAUSES, ONE SENTENCE. In a browser it means the deploy moved under this tab and a reload will catch it
 * up. In the desktop app it means a newer build has been released, downloaded and verified onto this machine,
 * and a restart is all that is left (desktop-app/src-tauri/src/update.rs). The reader does not care which:
 * both are "you are behind, one click fixes it", and drawing them as two different things would eventually
 * mean drawing them at the same time.
 *
 * WHY IT EXISTS AT ALL. This app is not a page people reload. It is a workspace left open across days, and
 * inside the desktop app it is never reloaded even in principle: that window is HIDDEN on close rather than
 * destroyed, on purpose, so it keeps the session it signed in with (windows.rs). A build shipped on Monday was
 * still on screen on Friday with nothing anywhere saying so.
 *
 * BOTTOM RIGHT, NOT TOP CENTRE. The top strip belongs to things the user still owes an answer to — a push that
 * failed, a check that said no (PushNotice.vue) — and this is not one of those. Nothing is broken, nothing is
 * waiting, and it will still be true in an hour. It sits out of the way, above the composer's side of the
 * screen rather than over the rail, and it can be waved off.
 *
 * IT NEVER ACTS BY ITSELF. No reload on a timer, no restart while somebody is mid-sentence. The only update
 * that happens without being asked is the desktop app's, on QUIT, where there is nothing to interrupt.
 *
 * "Not now" lasts as long as this offer does and no longer: the next build re-asks, because what was dismissed
 * is not what is now on the table (composables/appUpdate.ts). */

const { offer, take, dismiss } = useAppUpdate();
</script>

<template>
    <div
        v-if="offer"
        class="fixed bottom-3 right-3 z-40 flex max-w-[22rem] items-start gap-2 rounded-lg border border-line-strong bg-card p-3 shadow-lg"
        role="status"
    >
        <Icon name="refresh" class="mt-0.5 shrink-0 text-xs text-info" aria-hidden="true" />
        <div class="min-w-0 flex-1">
            <p class="text-xs font-medium text-content">
                <template v-if="offer.kind === `app`">Intentic {{ offer.version }} is ready</template>
                <template v-else>A new version of Intentic is out</template>
            </p>
            <!-- What the click COSTS, said before it is pressed. A restart closes the window; a reload throws
                 away whatever this page is holding that it has not sent. Neither is a surprise anybody should
                 meet after the fact. -->
            <p class="mt-0.5 text-2xs text-muted">
                <template v-if="offer.kind === `app`">It is downloaded. Restarting takes a few seconds.</template>
                <template v-else>Reload to pick it up.</template>
            </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
            <Button size="small" severity="secondary" :label="offer.kind === `app` ? `Restart` : `Reload`" @click="take" />
            <button
                type="button"
                class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-content"
                aria-label="Not now"
                v-tooltip.top="'Not now'"
                @click="dismiss"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>
    </div>
</template>
