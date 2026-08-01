<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract";
import { Button, cmp, CopyButton, Dialog, Icon } from "@intentic/extension-ui";
import { computed, ref, toRef } from "vue";
import { since } from "./cronSchedule";
import { type DoorbellInstall, embedSnippet, useAutomations, useDoorbellInstalls } from "./useAutomations";

/* "Did the snippet land?" — the question the app could not answer until the config route started recording who
 * asks for it.
 *
 * This panel exists because copying the snippet is the ONLY act that matters for a Doorbell, and everything
 * about it used to happen once, inside the create dialog, at the moment the user was least able to act on it:
 * they had not opened their site's code yet. So the snippet lives here instead, reachable from the row forever,
 * with the thing that was missing entirely beside it — whether a browser has actually loaded it.
 *
 * The refused-origin row is the point of the whole feature. www.example.com and example.com are different
 * origins, a site that redirects one to the other still loads the widget from whichever the browser was on, and
 * before this the symptom was a chat that silently never opened. Now it is a line naming the origin and a
 * button that adds it. */

const props = defineProps<{ automation: AutomationSummary }>();
const visible = defineModel<boolean>(`visible`, { default: false });

const { save } = useAutomations();
const { installs, isLoading, error } = useDoorbellInstalls(
    computed(() => props.automation.id),
    toRef(visible),
);

const snippet = computed(() => embedSnippet(props.automation) ?? ``);
const allowedOrigins = computed<string[]>(() => {
    const trigger = props.automation.trigger;
    return trigger.kind === `listener` ? [...(trigger.allowedOrigins ?? [])] : [];
});

// Split rather than sorted: a refused origin is an ACTION and a working one is reassurance, and mixing them by
// recency would bury the action under the reassurance on a busy site.
const refused = computed<DoorbellInstall[]>(() => installs.value.filter((probe) => !probe.allowed));
const loaded = computed<DoorbellInstall[]>(() => installs.value.filter((probe) => probe.allowed));

const addError = ref<string | undefined>(undefined);
const adding = ref<string | undefined>(undefined);

// One click on the commonest setup mistake: append the origin the browser actually used to the allowlist.
const allowOrigin = async (origin: string): Promise<void> => {
    const trigger = props.automation.trigger;
    if (trigger.kind !== `listener`) {
        return;
    }
    adding.value = origin;
    addError.value = undefined;
    try {
        const { runs: _runs, nextRun: _nextRun, ...automation } = props.automation;
        await save.mutateAsync({
            ...automation,
            trigger: { ...trigger, allowedOrigins: [...(trigger.allowedOrigins ?? []), origin] },
        });
    } catch (err) {
        addError.value = err instanceof Error ? err.message : `Could not add that site.`;
    } finally {
        adding.value = undefined;
    }
};
</script>

<template>
    <Dialog v-model:visible="visible" :modal="true" :draggable="false" :dismissable-mask="true" :style="{ width: '34rem' }" header="Install">
        <div class="flex flex-col gap-4">
            <!-- The deliverable, first and unmissable. Everything below it is about whether it worked. -->
            <div class="ui-field">
                <span class="ui-field-label">Paste this into your site, before &lt;/body&gt;</span>
                <div class="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                    <code class="min-w-0 flex-1 break-all font-mono text-2xs text-content">{{ snippet }}</code>
                    <CopyButton :text="snippet" :aria-label="`Copy the embed snippet for ${automation.id}`" />
                </div>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">Allowed sites</span>
                <div v-if="allowedOrigins.length > 0" class="flex flex-wrap gap-1.5">
                    <code v-for="origin in allowedOrigins" :key="origin" class="rounded bg-overlay px-2 py-1 font-mono text-2xs text-muted">
                        {{ origin }}
                    </code>
                </div>
                <p v-else :class="cmp.alertDanger()">
                    No sites are allowed yet, so every visitor is turned away. Add one below or edit the automation.
                </p>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">Has it loaded?</span>

                <p v-if="error" :class="cmp.alertDanger()">{{ error }}</p>

                <!-- The waiting state is a real state, not an empty one: it tells the user what to DO to make it
                     change, which is the only useful thing to say while nothing has happened yet. -->
                <div v-else-if="installs.length === 0" class="flex items-start gap-2 rounded-md bg-overlay px-3 py-2.5 text-xs text-muted">
                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                    <span v-if="isLoading">Checking…</span>
                    <span v-else>
                        No browser has loaded this widget yet. Paste the snippet, open your site, and this updates on its own within a few seconds.
                    </span>
                </div>

                <template v-else>
                    <!-- Refused first: it is the one line here that asks for an action. -->
                    <div
                        v-for="probe in refused"
                        :key="probe.origin"
                        class="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs"
                    >
                        <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
                        <span class="min-w-0 flex-1">
                            <code class="font-mono text-2xs text-content">{{ probe.origin }}</code>
                            <span class="text-muted"> asked and was turned away · {{ since(probe.lastSeenAt) }}</span>
                        </span>
                        <Button
                            size="small"
                            severity="secondary"
                            label="Allow"
                            :loading="adding === probe.origin"
                            :aria-label="`Allow ${probe.origin} to load this chat`"
                            @click="allowOrigin(probe.origin)"
                        />
                    </div>

                    <div v-for="probe in loaded" :key="probe.origin" class="flex items-center gap-2 px-1 text-xs">
                        <Icon name="check-circle" class="shrink-0 text-2xs text-success" />
                        <code class="min-w-0 flex-1 truncate font-mono text-2xs text-content">{{ probe.origin }}</code>
                        <span class="shrink-0 text-2xs text-subtle">
                            {{ probe.loads }} {{ probe.loads === 1 ? `load` : `loads` }} · {{ since(probe.lastSeenAt) }}
                        </span>
                    </div>

                    <p v-if="addError" :class="cmp.alertDanger()">{{ addError }}</p>
                </template>
            </div>
        </div>

        <template #footer>
            <div class="flex justify-end">
                <Button label="Done" @click="visible = false" />
            </div>
        </template>
    </Dialog>
</template>
