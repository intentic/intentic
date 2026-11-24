<!-- The design kit's dock over the composer: its lines in every tone, alone and together, at a desktop pane's width and a phone's. -->
<script setup lang="ts">
import { Button, SectionHeader, ui } from "@intentic/ui";
import ChatDock from "../chat/panel/dock/ChatDock.vue";
import ChatDockRow from "../chat/panel/dock/ChatDockRow.vue";

// Every press in the chat's footer is a line of one frame (ChatDock): the glyph says whose move it is in its colour, the
// words read first, the bright press stands last. Drawn here from the same component the chat draws, with made-up words.
const WIDTHS = [
    { key: `wide`, label: `Pane`, frame: `w-full max-w-2xl` },
    { key: `phone`, label: `Phone`, frame: `w-full max-w-90` },
] as const;
</script>

<template>
    <section class="flex flex-col gap-4">
        <SectionHeader label="Dock over the composer" :heading="2" />
        <p class="text-xs text-muted">One frame, a line each. Accent glyph and rim: the agent waits on you. Green: done. The bright press is last.</p>
        <div class="flex flex-wrap items-start gap-6">
            <div v-for="width in WIDTHS" :key="width.key" class="flex flex-col gap-4 @container" :class="width.frame">
                <span class="text-3xs text-subtle uppercase">{{ width.label }}</span>
                <ChatDock>
                    <ChatDockRow icon="list-check" tone="ask" kind="Plan" title="Add Stripe checkout" opens="Show in chat">
                        <template #actions>
                            <Button size="small" thumb tier="boring">Keep planning</Button>
                            <Button size="small" thumb tier="accent"><Icon name="check" />Approve</Button>
                        </template>
                    </ChatDockRow>
                </ChatDock>
                <ChatDock>
                    <ChatDockRow icon="check" tone="done" title="Landed">
                        <template #meta>22 files</template>
                        <template #detail><p class="truncate font-mono">feat(agent): add moveHere to bring runner conversations to this sandbox</p></template>
                        <template #actions>
                            <Button size="small" thumb tier="boring">Changes</Button>
                            <Button size="small" thumb tier="accent" tone="success"><Icon name="check" />Commit</Button>
                        </template>
                    </ChatDockRow>
                </ChatDock>
                <ChatDock>
                    <ChatDockRow icon="git-branch" tone="done" title="Ready to land">
                        <template #meta><span>9 files</span><span class="text-success">+210</span><span class="text-danger">−14</span></template>
                        <template #actions>
                            <Button size="small" thumb tier="boring">Review</Button>
                            <Button size="small" thumb tier="accent" tone="success"><Icon name="check" />Land</Button>
                        </template>
                    </ChatDockRow>
                    <ChatDockRow icon="clock" title="Stopped at your account's limit. It opens again at 14:00, in 2 hours." prose>
                        <template #actions>
                            <Button size="small" thumb tier="quiet">Try now</Button>
                            <Button size="small" thumb tier="accent"><Icon name="clock" />Continue at 14:00</Button>
                        </template>
                    </ChatDockRow>
                    <ChatDockRow icon="comments" tone="ask" kind="Question" title="Which store should the cache use?" opens="Answer">
                        <template #tail>
                            <button type="button" :class="ui.iconButton({ size: `sm` })" aria-label="Unfold"><Icon name="chevron-up" class="text-2xs" /></button>
                        </template>
                    </ChatDockRow>
                </ChatDock>
                <ChatDock>
                    <ChatDockRow icon="spinner" spin tone="busy" title="Landing" />
                    <ChatDockRow icon="exclamation-triangle" tone="warning" title="Push refused">
                        <template #meta>2 commits to push</template>
                        <template #actions>
                            <Button size="small" thumb tier="boring">See why</Button>
                            <Button size="small" thumb tier="accent" tone="success"><Icon name="arrow-up" />Push</Button>
                        </template>
                    </ChatDockRow>
                </ChatDock>
            </div>
        </div>
    </section>
</template>
