<script setup lang="ts">
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { githubRepoOf } from "@intentic/registry";
import { BrandMark, cmp, Notice, type NoticeModel } from "@intentic/ui";
import { computed } from "vue";
import { checksOk, checksProblem, type DiscoverListing, splitListingName } from "./discoverListing";

/* ONE LISTING, READ BEFORE IT IS RUN — and the surface where this product's actual argument about trust gets
 * made instead of implied.
 *
 * Three layers protect somebody installing an extension, and until now the app stated none of them at the
 * moment of the decision: the sha pins what runs, the manifest bounds what it may reach, and the registry may
 * or may not have had a human read the code. They guarantee genuinely different things, so they are three
 * lines here rather than one badge — and the third one is allowed to say NO. "Nobody has read this code" is
 * the honest default for most listings and printing it plainly is the point; a surface that only ever showed
 * the green states would be selling, not informing.
 *
 * THE STRONGEST MOVE IS OFFERED WHERE IT IS MOST NEEDED. The owner's own agent can read the exact commit cold
 * and report back before anything is installed, which is the only thing on this screen that can answer "does
 * the code do what the description says". On a reviewed listing that is a secondary offer beside Install. On an
 * unreviewed one it is the PRIMARY button and Install steps back to a plain one — not to discourage installing,
 * but because "nobody read it" and "here is how to have it read" belong in the same breath. */

const { listing, canInstall, installing } = defineProps<{
    listing: DiscoverListing;
    /** Installing is the owner's alone; everyone else browses. */
    canInstall: boolean;
    installing: boolean;
    failure?: NoticeModel | undefined;
}>();

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ install: []; audit: [] }>();

const name = computed(() => splitListingName(listing.entry.name));
const problem = computed(() => checksProblem(listing.entry));
const loads = computed(() => checksOk(listing.entry));
const verified = computed(() => listing.entry.trust === `verified`);
const ref40 = computed(() => listing.entry.install?.ref);
const shortRef = computed(() => ref40.value?.slice(0, 10));
const repo = computed(() => githubRepoOf(listing.entry.install));
const sourceHref = computed(() => {
    const url = listing.entry.install?.url;
    if (url === undefined) {
        return undefined;
    }
    // A GitHub pointer can link at the exact commit, which is the only link worth having here — the branch
    // shows code that is not what would be installed.
    return repo.value !== undefined && ref40.value !== undefined ? `https://github.com/${repo.value}/tree/${ref40.value}` : url.replace(/\.git$/, ``);
});

// An audit reads a commit, so it is offered exactly when there is one to read. Everything else on this panel
// renders regardless — a listing nobody can install is still a listing somebody may want to understand.
const auditable = computed(() => ref40.value !== undefined && listing.state.kind !== `blocked`);
const actionable = computed(() => listing.state.action !== undefined && canInstall);
// The audit leads wherever the registry has not vouched for the code. See the block comment above.
const auditLeads = computed(() => auditable.value && !verified.value);
</script>

<template>
    <!-- The footer WRAPS, which is not cosmetic: its primary label is a sentence ("Have my agent read the code
         first") because that is the offer this panel exists to make, and on a phone that sentence plus Install
         is wider than the dialog — unwrapped, the one control that matters most is the one that gets clipped. -->
    <Dialog
        v-model:visible="open"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :style="{ width: '38rem', maxWidth: '95vw' }"
        :pt="{ content: { class: `max-h-[70dvh] overflow-y-auto` }, footer: { class: `flex flex-wrap justify-end gap-2` } }"
    >
        <template #header>
            <div class="flex min-w-0 items-center gap-3">
                <BrandMark :size="32" :name="listing.entry.name" :logo="listing.entry.logo" :icon="listing.entry.icon" />
                <div class="min-w-0">
                    <div class="truncate font-medium text-content">{{ name.title }}</div>
                    <div class="truncate text-2xs text-subtle">{{ listing.entry.name }}</div>
                </div>
            </div>
        </template>

        <div class="flex flex-col gap-4">
            <p v-if="listing.entry.description" class="text-sm leading-relaxed text-muted">{{ listing.entry.description }}</p>

            <!-- The facts that are just facts, in one line: what it calls itself, what it costs, how popular it
                 is. Everything that is a CLAIM about safety is below, where it can be stated in full. -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                <span v-if="listing.entry.version">{{ listing.entry.version }}</span>
                <span v-if="listing.entry.stars !== undefined" class="inline-flex items-center gap-0.5"><Icon name="star" />{{ listing.entry.stars }}</span>
                <span v-if="listing.entry.category">{{ listing.entry.category }}</span>
                <span :class="listing.entry.tier === `premium` ? `text-primary-500` : ``">
                    {{ listing.entry.tier === "premium" ? "Premium — needs an intentic membership" : "Free" }}
                </span>
                <a
                    v-if="listing.entry.homepage"
                    :href="listing.entry.homepage"
                    target="_blank"
                    rel="noreferrer noopener"
                    class="inline-flex items-center gap-1 text-link hover:underline"
                >
                    Homepage <Icon name="external-link" />
                </a>
            </div>

            <!-- Where the state of this row is not "here it is to install", it is said before anything else on
                 the panel: a reader looking at a blocked listing must not have to reach the button to find out. -->
            <div v-if="listing.state.kind === `blocked`" :class="cmp.alertDanger()">
                <b>Blocked.</b> {{ listing.state.reason }} It stays listed rather than disappearing, because
                anyone who already installed it is the person this most concerns.
            </div>
            <div v-else-if="listing.state.kind === `unavailable`" :class="cmp.alertInfo()">{{ listing.state.reason }}</div>
            <div v-else-if="listing.state.kind === `installed`" :class="cmp.alertInfo()">
                Already installed in this sandbox, at this commit. Manage it on the Extensions tab.
            </div>
            <div v-else-if="listing.state.kind === `update`" :class="cmp.alertInfo()">
                You have this installed at <code class="ui-code">{{ listing.state.installedRef?.slice(0, 10) }}</code
                >. The listing points at <code class="ui-code">{{ shortRef }}</code
                >. Updating replaces the code wholesale, and re-asks if it wants more than you approved.
            </div>

            <!-- THE TRUST BLOCK. Three different parties guarantee three different things; a single badge
                 would blur which. Ordered by how much each actually settles. -->
            <div class="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
                <div :class="cmp.sectionLabel()">What you'd be trusting</div>

                <div v-if="verified" class="flex items-start gap-2 text-xs">
                    <Icon name="shield" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-content">
                        <b>Reviewed</b> — someone here read the source at this commit.
                        <span v-if="listing.entry.trustReason" class="text-muted">{{ listing.entry.trustReason }}</span>
                    </span>
                </div>
                <div v-else class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-content">
                        <b>Not reviewed</b> — the pointer resolves and the manifest parses.
                        <span class="text-muted">Nobody here has read this code.</span>
                    </span>
                </div>

                <div v-if="ref40" class="flex items-start gap-2 text-xs">
                    <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-content">
                        <b>Pinned</b> — you install commit <code class="ui-code">{{ shortRef }}</code
                        >. <span class="text-muted">A force-push upstream cannot change what runs here.</span>
                    </span>
                </div>

                <div class="flex items-start gap-2 text-xs">
                    <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-content">
                        <b>Bounded</b> —
                        <span class="text-muted">
                            it can only do what it declares, you'll see that list before you approve, and it can't grow past it without asking you
                            again.
                        </span>
                    </span>
                </div>

                <!-- The scan's cold re-read. Evidence, not endorsement, and silent where there is none: a
                     registry that runs no scanner has not failed a check. -->
                <div v-if="loads" class="flex items-start gap-2 text-xs">
                    <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-muted">Re-checked at this exact commit by the registry's nightly scan — the manifest parses and it loads.</span>
                </div>
                <div v-else-if="problem" class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-muted">{{ problem }}</span>
                </div>
            </div>

            <div v-if="sourceHref" class="flex flex-wrap items-baseline gap-x-2 text-2xs">
                <span class="text-subtle">Source</span>
                <a :href="sourceHref" target="_blank" rel="noreferrer noopener" class="inline-flex items-center gap-1 font-mono text-link hover:underline">
                    {{ repo ?? listing.entry.install?.url }}<span v-if="shortRef"> @ {{ shortRef }}</span> <Icon name="external-link" />
                </a>
            </div>
            <p v-if="listing.entry.install?.path" class="text-2xs text-subtle">
                Lives in <code class="ui-code">{{ listing.entry.install.path }}</code> inside that repository.
            </p>

            <Notice v-if="failure" :of="failure" />
            <p v-if="listing.state.action !== undefined && !canInstall" class="text-2xs text-subtle">
                Only the sandbox owner can install extensions.
            </p>
        </div>

        <template #footer>
            <!-- Order follows what the listing has actually earned: where the code has been read by somebody,
                 Install leads; where it has not, the read leads and Install stands beside it. -->
            <Button
                v-if="auditable"
                :label="auditLeads ? `Have my agent read the code first` : `Read the code first`"
                :severity="auditLeads ? undefined : `secondary`"
                :text="!auditLeads"
                :outlined="auditLeads"
                size="small"
                @click="emit(`audit`)"
            >
                <template #icon><Icon name="sparkles" /></template>
            </Button>
            <Button
                v-if="actionable"
                :label="listing.state.action"
                size="small"
                :loading="installing"
                :severity="auditLeads ? `secondary` : undefined"
                @click="emit(`install`)"
            />
        </template>
    </Dialog>
</template>
