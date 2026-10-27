<!-- WHAT A SANDBOX IS, DRAWN RATHER THAN TOLD, for Home's first run (HomeNoSandbox.vue). The whole loop in one figure,
     left to right on a wide pane and top to bottom on a narrow one: you say what you want (a chat bubble beside your own
     avatar), agents do it inside the sandbox (the one framed thing, holding them and your files, with where it can run),
     and you keep the change (a diff, approved). It replaced three numbered lines of prose ("Its home conversation plans
     the work and hands it to agents") that leaned on words a newcomer does not have yet (2026-10-27).
     Every piece is a picture of what the reader will meet later, never decoration: the bubble wears the chat prompt's own
     surface (chat.css `.chat-surface`), the faces are the assistants that work in a sandbox, the bars a diff's own marks
     (tone.ts `diffMark`), and the box glyph the rail tile the sandbox becomes. The bubble's words are an example, and the
     file under the diff is the one that example would touch. -->
<script setup lang="ts">
import { AssistantFace, Avatar, Icon, diffMark, toneDot, tonePlate } from "@intentic/ui";
import type { AssistantAccessory } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useAuth } from "../../client/auth/useAuth";

const t = useT();
const { user } = useAuth();

// Three at once, each holding what it works with (code, research, writing), one already finished: a sandbox runs
// several side by side, and they do more than code. Seeds picked for three bodies that tell apart in every look.
const AGENTS: readonly { seed: string; accessory: AssistantAccessory; width: string; done: boolean }[] = [
    { seed: `welcome-coder`, accessory: `terminal`, width: `w-3/5`, done: false },
    { seed: `welcome-researcher`, accessory: `magnifier`, width: `w-2/5`, done: false },
    { seed: `welcome-writer`, accessory: `scroll`, width: `w-full`, done: true },
];

// Lines of a change, as the diff viewers mark them: mostly added, one removed.
const DIFF: readonly { added: boolean; width: string }[] = [
    { added: true, width: `w-4/5` },
    { added: true, width: `w-3/5` },
    { added: false, width: `w-2/3` },
    { added: true, width: `w-11/12` },
    { added: true, width: `w-1/2` },
];

// The step names sit on the figure's first row and the pictures on its second, so on a wide pane every picture starts
// on one line whichever name wraps (subgrid), and the arrows centre on the pictures rather than on the names. Every cell
// names its column there: an arrow pinned to the second row is placed before anything that is not, and would otherwise
// take the first free columns.
const STEP = `grid min-w-0 gap-2 @2xl:row-span-2 @2xl:grid-rows-subgrid @2xl:gap-3`;
const STEP_NAME = `text-balance text-center text-sm font-medium text-content`;
// Pointing down while the steps stack, right once they stand side by side.
const ARROW = `flex justify-center text-subtle @2xl:row-start-2 @2xl:self-center`;
const ARROW_GLYPH = `rotate-90 @2xl:rotate-0`;
</script>

<template>
    <figure class="@container m-0 w-full" :aria-label="t(`home.firstRun.figure`)">
        <div class="grid grid-cols-1 gap-x-4 gap-y-2 @2xl:gap-y-3 @2xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.3fr)_auto_minmax(0,1fr)]">
            <!-- 1. You ask. -->
            <div :class="STEP" class="@2xl:col-start-1">
                <p :class="STEP_NAME">{{ t(`home.firstRun.steps.ask.title`) }}</p>
                <div class="flex items-end justify-center gap-2 self-center">
                    <span class="chat-surface max-w-48 px-3.5 py-2 text-xs leading-relaxed text-content">{{ t(`home.firstRun.steps.ask.example`) }}</span>
                    <Avatar :size="28" :name="user?.name ?? undefined" :src="user?.image" />
                </div>
            </div>
            <span :class="ARROW" class="@2xl:col-start-2" aria-hidden="true"><Icon name="arrow-right" :class="ARROW_GLYPH" /></span>

            <!-- 2. Agents work inside the sandbox: the one framed thing, holding them and your files. -->
            <div :class="STEP" class="@2xl:col-start-3">
                <p :class="STEP_NAME">{{ t(`home.firstRun.steps.work.title`) }}</p>
                <div class="flex flex-col items-center gap-2">
                    <div class="flex w-full max-w-72 flex-col gap-2.5 rounded-xl border border-line-strong bg-canvas/60 p-3 shadow-sm">
                        <span class="flex items-center gap-1.5 text-xs font-medium text-content">
                            <Icon name="box" class="text-subtle" aria-hidden="true" />{{ t(`home.firstRun.steps.work.sandbox`) }}
                        </span>
                        <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
                            <li v-for="agent in AGENTS" :key="agent.seed" class="flex items-center gap-2.5">
                                <AssistantFace :seed="agent.seed" :accessory="agent.accessory" :size="36" :label="t(`home.firstRun.steps.work.agent`)" />
                                <span class="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
                                    <span
                                        class="absolute inset-y-0 left-0 rounded-full"
                                        :class="[agent.width, agent.done ? `bg-success` : `bg-primary-fill motion-safe:animate-pulse`]"
                                    />
                                </span>
                                <Icon :name="agent.done ? `check-circle` : `circle`" class="text-xs" :class="agent.done ? `text-success` : `invisible`" aria-hidden="true" />
                            </li>
                        </ul>
                        <span class="flex items-center gap-1.5 border-t border-line-subtle pt-2 text-2xs text-muted">
                            <Icon name="folder" class="text-subtle" aria-hidden="true" />{{ t(`home.firstRun.steps.work.files`) }}
                        </span>
                    </div>
                    <!-- Where it can run: the two places the new sandbox's dialog offers first. -->
                    <span class="flex max-w-72 items-center justify-center gap-1.5 text-balance text-center text-2xs text-muted">
                        <Icon name="cloud" class="text-subtle" aria-hidden="true" />
                        <Icon name="desktop" class="text-subtle" aria-hidden="true" />
                        {{ t(`home.firstRun.steps.work.where`) }}
                    </span>
                </div>
            </div>
            <span :class="ARROW" class="@2xl:col-start-4" aria-hidden="true"><Icon name="arrow-right" :class="ARROW_GLYPH" /></span>

            <!-- 3. You keep the change. -->
            <div :class="STEP" class="@2xl:col-start-5">
                <p :class="STEP_NAME">{{ t(`home.firstRun.steps.keep.title`) }}</p>
                <div class="relative mx-auto flex w-full max-w-44 flex-col gap-1.5 self-center rounded-lg border border-line bg-card p-2.5 shadow-sm">
                    <!-- A file name, which no language translates: the one the example ask would change. -->
                    <span class="font-mono text-2xs text-subtle">theme.css</span>
                    <span v-for="(line, index) in DIFF" :key="index" class="flex h-2.5 items-center pl-1.5" :class="diffMark(line.added ? `added` : `removed`, `rule`)">
                        <span class="h-1 rounded-full" :class="[line.width, toneDot(line.added ? `success` : `danger`)]" />
                    </span>
                    <span class="absolute -right-2.5 -top-2.5 grid size-6 place-items-center rounded-full shadow-sm" :class="tonePlate(`success`)">
                        <Icon name="check" class="text-xs" :aria-label="t(`home.firstRun.steps.keep.kept`)" role="img" />
                    </span>
                </div>
            </div>
        </div>
    </figure>
</template>
