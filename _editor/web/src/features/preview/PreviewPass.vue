<!-- Where a guarded preview's "Continue to Intentic" lands: signs this browser in to the preview and sends it back there. -->
<script setup lang="ts">
import { AppBrand, Button, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { forgetPass, passedTooRecently, passLinkFor, passRequestOf, rememberPass } from "./previewPassRules";

// `/preview-pass?url=<a preview's address>`, behind sign-in (the router's `requireAuth`, which brings a signed-out
// visitor back here). A preview its owner keeps to members sends a visitor with no pass here (previewPassRules.ts). The
// address names its sandbox; one this account lists is asked for a one-time link to the address, and the browser goes
// through it, coming back to the preview holding its pass. The page navigates only to the daemon's answer, never to the
// address it was handed: the daemon refuses any address that is not its own, which is what keeps this from being an open
// redirect. Whatever stops it is said in place, with a way on.

const t = useT();
const route = useRoute();
const { list } = useSandbox();

const request = passRequestOf(route.query);

// What the page says instead of sending the browser on; undefined while it works. `sandbox` is the listed sandbox the
// way out leads into (Home otherwise), and `retry` whether asking again could change the answer.
interface Stop {
    readonly notice: NoticeModel;
    readonly sandbox?: string;
    readonly retry?: boolean;
}
const stopped = ref<Stop | undefined>(undefined);

const open = async (): Promise<void> => {
    stopped.value = undefined;
    if (request === undefined) {
        stopped.value = { notice: noticeOf(t(`preview.previewPass.notAPreview`), { tone: `warning` }) };
        return;
    }
    let listed: string | undefined;
    try {
        listed = (await list()).find((row) => row.id === request.sandboxId)?.id;
    } catch (error) {
        stopped.value = { notice: noticeFrom(error, t(`preview.previewPass.couldntList`)), retry: true };
        return;
    }
    if (listed === undefined) {
        stopped.value = { notice: noticeOf(t(`preview.previewPass.notListed`), { tone: `warning` }) };
        return;
    }
    // Back here moments after a pass to this preview: the browser did not keep it, and another would only come back too.
    if (passedTooRecently(request.host, Date.now())) {
        const notice: NoticeModel = { tone: `warning`, title: t(`preview.previewPass.notKept`), detail: t(`preview.previewPass.notKeptDetail`, { host: request.host }) };
        stopped.value = { notice, sandbox: listed, retry: true };
        return;
    }
    try {
        const answer = await sandboxRpc.ports.previewPass({ url: request.url }, { context: { at: listed } });
        const link = passLinkFor(answer.url, request.url);
        if (link === undefined) {
            stopped.value = { notice: noticeOf(t(`preview.previewPass.refused`)), sandbox: listed };
            return;
        }
        rememberPass(request.host, Date.now());
        globalThis.location.replace(link);
    } catch (error) {
        stopped.value = { notice: noticeFrom(error, t(`preview.previewPass.refused`)), sandbox: listed, retry: true };
    }
};

// Asked for by the person, who may have just allowed the cookie: the last pass no longer stands in the way.
const again = (): void => {
    forgetPass();
    void open();
};

onMounted(() => void open());
</script>

<template>
    <div class="entry arrival">
        <div class="entry-plate" aria-hidden="true"><div class="entry-plate-img"></div></div>

        <main class="shell">
            <header class="mark"><AppBrand /></header>

            <!-- No frame while it works: nothing is being asked, so there is nothing to put a frame round. -->
            <template v-if="stopped === undefined">
                <div class="entry-seal entry-seal-turning" aria-hidden="true">
                    <span class="entry-seal-ring"></span>
                    <span class="entry-seal-sweep"></span>
                    <AppBrand shape="mark" class="entry-seal-mark" />
                </div>
                <p class="say" role="status">{{ t(`preview.previewPass.opening`) }}</p>
            </template>

            <section v-else class="entry-frame gate">
                <span class="entry-corner entry-corner-tl"></span>
                <span class="entry-corner entry-corner-tr"></span>
                <span class="entry-corner entry-corner-bl"></span>
                <span class="entry-corner entry-corner-br"></span>
                <Notice :of="stopped.notice" class="rounded-none text-left" />
                <div class="mt-4 flex flex-wrap justify-center gap-2">
                    <Button v-if="stopped.retry" :label="t(`ui.action.tryAgain`)" tier="accent" @click="again" />
                    <Button
                        :as="RouterLink"
                        :to="stopped.sandbox === undefined ? `/` : { path: `/`, query: { sandbox: stopped.sandbox } }"
                        :label="stopped.sandbox === undefined ? t(`preview.previewPass.home`) : t(`preview.previewPass.openSandbox`)"
                        :tier="stopped.retry ? `boring` : `accent`"
                    />
                </div>
            </section>
        </main>
    </div>
</template>

<style scoped>
/* Layout only; the plate, the frame and the seal are shared material in @intentic/entry-css, as on /desktop-auth/complete. */
.arrival {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(1rem, 2.5vw, 2rem) 1.5rem;
}
.shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 30rem;
    margin: auto;
    text-align: center;
}
.mark {
    font-size: 1.375rem;
    margin-bottom: clamp(1.5rem, 5vh, 2.75rem);
}
.say {
    font-size: 0.9375rem;
    color: var(--ink-muted);
}
.gate {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 1.75rem 1.75rem 1.5rem;
}
</style>
