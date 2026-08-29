<script setup lang="ts">
import type { ClaimableName, ClaimChallenge } from "@intentic-app/api-contract";
import type { GitPublishFileResult, GitRemoteRepos } from "@intentic/sandbox-contract";
import { Button, CopyButton, Notice, type NoticeModel, RowGroup, RowNote, ui } from "@intentic/ui";
import { noticeFrom, useAsyncAction } from "@intentic/ui/async";
import { computed, onMounted, ref } from "vue";
import { jsonBody } from "../../composables/sandbox/jsonBody";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { apiClient } from "../../composables/useApi";
import { claimCommand, claimTargets, domainClaimUrl, isDomainChallenge, publishFailureNotice } from "./publisherClaim";

/* PROVING A PUBLISHER NAME IS YOURS. Rebuilt around what the creator actually has in front of them.
 *
 * WHAT WAS WRONG. The screen asked for a name in an empty box, then answered with a token and a comma-separated
 * list of every repository the registry lists under it: "commit a file called .intentic-claim containing this
 * token to the default branch of A, B, C, D, E, F, and any one of them is enough". Three things a creator could
 * not tell from that, all of which decide whether they succeed:
 *
 *   1. THAT THE LIST IS NOT A CHOICE THEY MAKE. It is every repository the official registry already ties to
 *      the name, and push access to one of them IS the proof. A fresh empty repository proves nothing, so the
 *      obvious "just make me a repo for it" shortcut cannot exist, and the screen has to say why the list is
 *      what it is instead of presenting six unexplained options.
 *   2. THAT WHICH ONE THEY PICK DOES NOT MATTER. Any of them proves the same thing, so asking is a decision
 *      handed to the person least able to make it. One is picked here, the rest go behind a disclosure.
 *   3. THAT IT HAS TO BE THE DEFAULT BRANCH. The proof is read back from the repository's public HEAD, so a
 *      push to a side branch verifies never, and the old failure message ("no file carrying your token was
 *      readable") did not mention branches at all.
 *
 * WHAT IT DOES NOW. The workspace already knows which repositories are checked out here and where each one
 * lives online, so: the names those repositories publish under are offered as buttons (no typing), the
 * repository open here is the one proposed, and one button writes the file, commits it, pushes it and verifies
 * the claim. The typed box and the paste-one-line path both remain, for a name whose repositories are not open
 * here, which is the ordinary case for a team name. */

const emit = defineEmits<{ claimed: [] }>();

const publisher = ref(``);
const challenge = ref<ClaimChallenge | null>(null);
const suggestions = ref<readonly ClaimableName[]>([]);
// Where each workspace repo lives online: what turns "one of six slugs" into "the one you have open".
const localRepos = ref<GitRemoteRepos[`repos`]>([]);
const chosen = ref<string | undefined>(undefined);
const showAll = ref(false);

/* THREE ACTIONS, THREE BUSY FLAGS: the card's existing rule, for its existing reason: one shared flag made
 * every button spin whenever any of them was pressed, which reads as "the whole card is doing something". */
const { busy: checking, notice: checkNotice, run: runCheck } = useAsyncAction();
const proving = ref(false);
const proveNotice = ref<NoticeModel | undefined>(undefined);
// What the prove button is doing right now. Two round trips hide behind one press (push, then verify) and a
// button that just spins for both makes the slow half look like a hang.
const step = ref<string | undefined>(undefined);
/* The file is pushed and only verification is left. Kept because GitHub does not always serve a fresh commit
 * to raw.githubusercontent.com the instant the push returns: the retry after that must not try to publish a
 * file that is already there, and the button has to stop saying "add the proof". */
const published = ref(false);

/* The workspace's repositories, and the names they publish under. Both are best-effort: a sandbox that is not
 * reachable, or a registry that is down, costs the creator the suggestions and the one-click path, never the
 * ability to claim, which is why nothing here surfaces a failure. */
const loadSuggestions = async (): Promise<void> => {
    const repos = await sandboxJson<GitRemoteRepos>(`/git/remote-repos`)
        .then((answer) => answer.repos)
        .catch(() => []);
    localRepos.value = repos;
    const projects = repos.filter((repo) => repo.host === `github.com`).map((repo) => repo.project);
    if (projects.length === 0) {
        return;
    }
    suggestions.value = await apiClient.creator
        .claimable({ projects })
        .then((answer) => answer.names)
        .catch(() => []);
};

onMounted(loadSuggestions);

// Every repository this claim can be proved from, ones open here first (claimTargets).
const targets = computed(() => (challenge.value === null ? [] : claimTargets(challenge.value, localRepos.value)));
const target = computed(() => targets.value.find((entry) => entry.project === chosen.value) ?? targets.value[0]);
const command = computed(() => (challenge.value === null || target.value === undefined ? `` : claimCommand(challenge.value, target.value.project)));
// The domain lane: a dotted name proves itself from its own well-known path, and has no repositories at all.
const domainLane = computed(() => challenge.value !== null && isDomainChallenge(challenge.value));
const domainUrl = computed(() => (challenge.value === null ? `` : domainClaimUrl(challenge.value)));

const reset = (): void => {
    proveNotice.value = undefined;
    published.value = false;
    chosen.value = undefined;
    showAll.value = false;
};

const look = async (name: string): Promise<void> => {
    const wanted = name.trim().toLowerCase();
    if (wanted === ``) {
        return;
    }
    await runCheck(async () => {
        reset();
        publisher.value = wanted;
        challenge.value = await apiClient.creator.challenge({ publisher: wanted });
    }, `Couldn't look that publisher up.`);
};

const pick = (project: string): void => {
    chosen.value = project;
    showAll.value = false;
    // A different repository is a different push; whatever the last one reported is no longer about this one.
    published.value = false;
    proveNotice.value = undefined;
};

const succeeded = async (): Promise<void> => {
    challenge.value = null;
    publisher.value = ``;
    reset();
    // The claimed name stops being a suggestion, and the card above needs to grow a row.
    await loadSuggestions();
    emit(`claimed`);
};

/* THE WHOLE CLAIM AS ONE PRESS: push the proof, then verify it. Two steps rather than two buttons because the
 * creator has no decision to make between them. The only reason the old screen made them press twice is that
 * it could not do the first half at all.
 *
 * A repository that is NOT open here skips straight to the verify, which is what the pasted line leads to. */
const prove = async (): Promise<void> => {
    const active = challenge.value;
    const where = target.value;
    // The domain lane has no repository on purpose: its "push" is the creator serving a file, so the only
    // step left here is the verify.
    if (proving.value || active === null || (where === undefined && !domainLane.value)) {
        return;
    }
    proving.value = true;
    proveNotice.value = undefined;
    try {
        if (!published.value && where?.repo !== undefined) {
            step.value = `Pushing the proof to ${where.project}…`;
            const result = await sandboxJson<GitPublishFileResult>(
                `/git/${encodeURIComponent(where.repo)}/publish-file`,
                jsonBody(`POST`, {
                    path: active.path,
                    content: `${active.token}\n`,
                    message: `Claim the ${active.publisher} publisher name`,
                }),
            );
            if (!result.ok) {
                proveNotice.value = publishFailureNotice(where.project, result);
                return;
            }
            published.value = true;
        }
        step.value = domainLane.value ? `Reading ${domainUrl.value}…` : `Checking GitHub…`;
        await apiClient.creator.claim({ publisher: active.publisher });
        await succeeded();
    } catch (caught) {
        // The platform's refusal now names the repositories it read and what each one said, so it rides as the
        // detail under this line rather than being replaced by it.
        proveNotice.value = noticeFrom(caught, published.value ? `Pushed, but GitHub isn't serving it yet.` : `That claim couldn't be verified yet.`);
    } finally {
        proving.value = false;
        step.value = undefined;
    }
};
</script>

<template>
    <!-- ITS OWN GROUP, not a heading inside somebody else's card. This is a step with a field, a set of
         suggestions, a command block and two round trips behind one button: everything else on the Getting paid
         tab is a <RowGroup>, and a flow of this size floating between two of them under a `text-xs` heading was
         the loudest part of that tab's mismatch. The body is one padded block rather than rows, because none of
         what follows is a list. -->
    <RowGroup label="Claim a publisher name">
        <RowNote variant="block">
            <div class="flex flex-col gap-3">
                <!-- Names the creator's own repositories publish under. Absent rather than empty when there are
                 none: an empty suggestion strip is a promise the screen just failed to keep. -->
                <div v-if="suggestions.length > 0" class="flex flex-col gap-1.5">
                    <span class="ui-field-label">Names your workspace repositories publish under</span>
                    <div class="flex flex-wrap gap-1.5">
                        <Button
                            v-for="name in suggestions"
                            :key="name.publisher"
                            :label="name.publisher"
                            severity="secondary"
                            size="small"
                            :loading="checking && publisher === name.publisher"
                            @click="look(name.publisher)"
                        />
                    </div>
                </div>

                <!-- A `div`, not a `label`, precisely because the button shares the field's row: a <label> wrapping
                 an interactive control hands clicks meant for it to the labelled input instead. -->
                <div class="ui-field">
                    <label class="ui-field-label" for="publisher-name">{{ suggestions.length > 0 ? `Or another name` : `Publisher name` }}</label>
                    <div class="flex gap-2">
                        <input
                            id="publisher-name"
                            v-model="publisher"
                            spellcheck="false"
                            autocapitalize="off"
                            placeholder="acme, or acme.dev"
                            :class="ui.input('min-w-0 flex-1')"
                            @keyup.enter="look(publisher)"
                        />
                        <Button label="Check" severity="secondary" :loading="checking" @click="look(publisher)" />
                    </div>
                    <span class="text-2xs text-subtle">
                        The publisher half of an extension id, or a domain you control. A dotted name proves itself from its own well-known path
                        instead of from a repository.
                    </span>
                </div>
                <Notice v-if="checkNotice" :of="checkNotice" />

                <!-- THE ANSWER TO "CHECK", set one step up from the field that asked for it. Everything under here
                 is `text-sm`, the app's body size, rather than the `text-xs` this screen used throughout: these
                 are the instructions the whole flow exists to give, and they were being set at the size the rest
                 of the app reserves for captions. -->
                <template v-if="challenge">
                    <div class="flex flex-col gap-3 border-t border-line-subtle pt-3">
                        <p v-if="challenge.claimedByYou" class="text-sm text-muted">You already hold this name.</p>
                        <p v-else-if="challenge.claimedByOther" class="text-sm text-muted">
                            Another account already holds this name. If that's wrong, get in touch. A name is settled by who proved it first.
                        </p>

                        <!-- THE DOMAIN LANE: a dotted name proves itself from its own well-known path, with no
                         registry, no repositories. The same why-before-what rule as the repo lane below. -->
                        <template v-else-if="domainLane">
                            <p class="text-sm text-muted">
                                Only someone who controls <span class="font-medium text-content">{{ challenge.publisher }}</span> could serve a file
                                at its well-known path. That's the proof. Serve this exact line as plain text at
                                <span class="font-mono break-all text-content">{{ domainUrl }}</span
                                >:
                            </p>
                            <div class="flex items-start gap-2">
                                <pre
                                    class="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap"
                                    >{{ challenge.token }}</pre>
                                <CopyButton :text="challenge.token" label="Copy" />
                            </div>
                            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                                <Button label="I'm serving it, verify" :loading="proving" @click="prove" />
                                <span v-if="step" class="text-xs text-muted">{{ step }}</span>
                            </div>
                            <Notice v-if="proveNotice" :of="proveNotice" />
                        </template>

                        <p v-else-if="targets.length === 0" class="text-sm text-muted">
                            The registry lists no GitHub-backed extension under this name, so there's nothing to prove ownership against yet.
                        </p>

                        <template v-else-if="target">
                            <!-- WHY, before what. This one sentence is the thing the old screen never said, and
                             without it the list of repositories below reads as an arbitrary demand. -->
                            <p class="text-sm text-muted">
                                Only someone who can push to a repository
                                <span class="font-medium text-content">{{ challenge.publisher }}</span> publishes from could put a file in one. That's
                                the proof.
                                <template v-if="targets.length > 1">Any of its {{ targets.length }} repositories works equally well.</template>
                            </p>

                            <!-- The one repository this will use, and how it was chosen. -->
                            <p class="text-sm text-muted">
                                Using <span class="font-mono text-content">{{ target.project }}</span>
                                <template v-if="target.repo">. It's open in your workspace, so this can do the whole thing for you.</template>
                                <template v-else>. It isn't open here, so this last bit is yours to run.</template>
                            </p>

                            <!-- IN-WORKSPACE: write, commit, push and verify, on one press. -->
                            <div v-if="target.repo" class="flex flex-wrap items-center gap-x-3 gap-y-2">
                                <Button :label="published ? `Check again` : `Add the proof and push`" :loading="proving" @click="prove" />
                                <span v-if="step" class="text-xs text-muted">{{ step }}</span>
                            </div>

                            <!-- ELSEWHERE: one line that does every step, then the same verify. -->
                            <template v-else>
                                <div class="flex items-start gap-2">
                                    <!-- Wrapped, not side-scrolled. The line is long enough to run off this panel,
                                     and a command whose end is hidden is one somebody squints at instead of
                                     trusting. -->
                                    <pre
                                        class="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap"
                                        >{{ command }}</pre>
                                    <CopyButton :text="command" label="Copy" />
                                </div>
                                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                                    <Button label="I've run it, verify" :loading="proving" @click="prove" />
                                    <span v-if="step" class="text-xs text-muted">{{ step }}</span>
                                </div>
                            </template>

                            <Notice v-if="proveNotice" :of="proveNotice" />

                            <!-- The other repositories, behind a disclosure: a real choice for the creator whose
                             default pick is archived or read-only, and noise for everyone else. The toggle is
                             the app's inline text action (`ui.linkButton`), not a hand-rolled underlined span:
                             that recipe carries the 36px thumb target this screen was missing. -->
                            <template v-if="targets.length > 1">
                                <button type="button" :class="ui.linkButton()" @click="showAll = !showAll">
                                    {{ showAll ? `Never mind` : `Use a different repository` }}
                                </button>
                                <!-- THE ONE IN USE IS MARKED, THE REST LOOK PRESSABLE. Told apart by weight alone
                                 they read as a list rather than as a choice, which is the state this disclosure
                                 exists to offer: the current pick wears a tick and the app's content colour, and
                                 every other line keeps the link colour that says it does something. -->
                                <div v-if="showAll" class="flex flex-col">
                                    <button
                                        v-for="entry in targets"
                                        :key="entry.project"
                                        type="button"
                                        :aria-current="entry.project === target.project ? `true` : undefined"
                                        :class="
                                            ui.linkButton(
                                                entry.project === target.project
                                                    ? `gap-1.5 font-mono font-medium text-content hover:no-underline`
                                                    : `gap-1.5 font-mono`,
                                            )
                                        "
                                        @click="pick(entry.project)"
                                    >
                                        <Icon
                                            :name="entry.project === target.project ? `check` : `circle`"
                                            class="shrink-0 text-2xs"
                                            :class="entry.project === target.project ? `text-success` : `text-subtle`"
                                        />
                                        {{ entry.project }}<template v-if="entry.repo"> · open here</template>
                                    </button>
                                </div>
                            </template>
                        </template>
                    </div>
                </template>
            </div>
        </RowNote>
    </RowGroup>
</template>
