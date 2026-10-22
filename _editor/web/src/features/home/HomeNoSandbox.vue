<script setup lang="ts">
import { EmptyState } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();
</script>

<template>
    <section class="ground-card flex min-h-0 min-w-0 flex-1 flex-col bg-card" data-home-no-sandbox>
        <EmptyState size="page" icon="comments" :title="t(`home.noSandboxTitle`)" :line="t(`home.noSandboxLine`)" class="min-h-0 flex-1" />
        <div class="mx-auto w-full max-w-3xl shrink-0 p-4">
            <fieldset disabled class="ui-field-shell flex min-w-0 flex-col rounded-2xl border-line-strong bg-overlay p-3 text-subtle opacity-60">
                <textarea
                    rows="2"
                    class="field-bare w-full resize-none"
                    :aria-label="t(`home.noSandboxComposer`)"
                    :placeholder="t(`home.noSandboxComposer`)"
                    aria-describedby="home-no-sandbox-reason"
                ></textarea>
                <div class="flex justify-end">
                    <button type="button" class="flex size-8 items-center justify-center rounded-full bg-content/5" :aria-label="t(`ui.action.send`)">
                        <Icon name="arrow-up" aria-hidden="true" />
                    </button>
                </div>
            </fieldset>
            <p id="home-no-sandbox-reason" class="mt-2 text-center text-xs text-muted" role="status">{{ t(`home.noSandboxComposer`) }}</p>
        </div>
    </section>
</template>
