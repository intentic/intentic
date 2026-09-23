import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { type PermissionMode, type RunnerSummary, RunnerSummarySchema, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { hoisted } from "@intentic/testing/bun";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { computed, createApp, h, nextTick, ref } from "vue";
import * as useAgentsOriginal from "../../../agents/fleet/useAgents";
import * as useRunnersOriginal from "../../../sandbox/devices/runners/useRunners";
import type { RunThroughState } from "../../models/run-settings/useRunThrough";
import type { ChatMessage } from "../../transcript/transcript";

// Pins the composer's row: a control waits in the overflow while it is at this chat's default and rides the row once
// set, the overflow hands off to the picker that owns the choice, and an armed edit or a workflow badge takes back
// whatever else would rewrite what Send means.

// The runners this sandbox has paired and the roster's entries, as the row reads them.
const { runners, rostered } = await hoisted(async () => {
    const { ref: vueRef } = await import(`vue`);
    return { runners: vueRef<RunnerSummary[]>([]), rostered: vueRef<readonly string[]>([]) };
});
// Held before the mocks replace the modules' bindings, which would otherwise answer with the mocks themselves.
const { useAgents } = useAgentsOriginal;
mock.module("../../../agents/fleet/useAgents", () => ({
    ...useAgentsOriginal,
    useAgents: () => ({ ...useAgents(), agentById: (id: string) => (rostered.value.includes(id) ? { id, status: `idle` } : undefined) }),
}));
mock.module("../../../sandbox/devices/runners/useRunners", () => ({ ...useRunnersOriginal, useRunners: () => ({ runners }) }));

const { useComposerControls } = await import("./composerControls");
const { Conversation } = await import("../../session/conversation");

let unmount: (() => void) | undefined;
const rowOf = () => {
    const chat = new Conversation(`c1`);
    // An isolated chat's own untouched posture.
    const mode = ref<PermissionMode>(`bypassPermissions`);
    const runState = ref<RunThroughState>(`idle`);
    const runThrough = { open: ref(false), state: computed(() => runState.value), clear: mock() };
    const steered = ref(false);
    const editing = ref<ChatMessage | undefined>();
    const pills = {
        mode: ref<HTMLElement>(document.createElement(`button`)),
        persona: ref<HTMLElement>(),
        runThrough: ref<HTMLElement>(),
        more: ref<HTMLElement>(document.createElement(`button`)),
    };
    let row: ReturnType<typeof useComposerControls> | undefined;
    const app = createApp({
        setup: () => {
            row = useComposerControls({
                conversation: () => chat,
                mode,
                provider: chat.selection.provider,
                model: chat.selection.model,
                runThrough,
                steered,
                editing,
                pills,
            });
            return () => h(`div`);
        },
    });
    app.mount(document.createElement(`div`));
    unmount = () => app.unmount();
    return { chat, mode, runState, runThrough, steered, editing, pills, row: row! };
};
const keys = (row: ReturnType<typeof rowOf>[`row`]): string[] => row.moreRows.value.map((entry) => entry.key);

afterEach(() => {
    unmount?.();
    unmount = undefined;
    runners.value = [];
    rostered.value = [];
    resetSandboxScope();
});

describe(`the row and its overflow`, () => {
    it(`keeps each control in the overflow at this chat's default, and brings a set one into the row`, () => {
        const { chat, mode, runState, row } = rowOf();
        expect(keys(row)).toEqual([`mode`, `persona`, `runThrough`]);
        expect(row.inRow.value).toEqual({ mode: false, persona: false, runThrough: false, voice: false });

        mode.value = `plan`;
        chat.selection.apply({ kind: `set`, picks: { actsAs: `backend` } });
        runState.value = `loop`;
        expect(keys(row)).toEqual([]);
        expect(row.inRow.value).toEqual({ mode: true, persona: true, runThrough: true, voice: false });
    });

    it(`offers writing as the agent once the chat has somewhere to place the words`, () => {
        const { chat, row } = rowOf();
        expect(keys(row)).not.toContain(`voice`);

        // On the roster: the daemon has an entry to place into, whatever this tab has latched.
        rostered.value = [`c1`];
        expect(keys(row)).toEqual([`mode`, `persona`, `runThrough`, `voice`]);

        rostered.value = [];
        chat.registered.value = true;
        expect(keys(row)).toEqual([`mode`, `persona`, `runThrough`, `voice`]);

        row.voiceAgent.value = true;
        expect(row.inRow.value.voice).toBe(true);
    });

    it(`offers no persona to a chat living in another box`, () => {
        const { chat, row } = rowOf();

        chat.box.value = `box-2`;

        expect(keys(row)).toEqual([`mode`, `runThrough`]);
        expect(row.remote.value).toBe(true);
    });

    it(`hands a row to the picker that owns it, closing itself first; the voice row is the press`, () => {
        const { runThrough, row } = rowOf();
        const picks = [`mode`, `persona`, `runThrough`, `voice`] as const;
        for (const control of picks) {
            row.moreOpen.value = true;
            row.openFromMore(control);
            expect(row.moreOpen.value, control).toBe(false);
        }

        expect(row.modeOpen.value).toBe(true);
        expect(row.personaOpen.value).toBe(true);
        expect(runThrough.open.value).toBe(true);
        expect(row.voiceAgent.value).toBe(true);
    });

    it(`opens a picker over its own chip while that rides the row, and over the overflow button otherwise`, () => {
        const { mode, pills, row } = rowOf();
        expect(row.modeAnchor.value).toBe(pills.more.value);

        mode.value = `plan`;

        expect(row.modeAnchor.value).toBe(pills.mode.value);
    });
});

describe(`what Send means`, () => {
    it(`drops the agent's voice and both run-through picks once an edit is armed`, async () => {
        const { editing, runThrough, row } = rowOf();
        row.voiceAgent.value = true;

        editing.value = { id: 1, role: `user`, text: `first` };
        await nextTick();

        expect(row.voiceAgent.value).toBe(false);
        expect(runThrough.clear).toHaveBeenCalledTimes(1);
    });

    it(`gives a workflow badge the composer: the voice disarms and the panels its greyed pills open close`, async () => {
        const { steered, row } = rowOf();
        for (const open of [row.voiceAgent, row.modelOpen, row.modeOpen, row.personaOpen, row.moreOpen, row.placementOpen]) {
            open.value = true;
        }

        steered.value = true;
        await nextTick();

        expect([row.voiceAgent, row.modelOpen, row.modeOpen, row.personaOpen, row.moreOpen].map((open) => open.value)).toEqual([
            false,
            false,
            false,
            false,
            false,
        ]);
        // Where the chat runs is not something a workflow decides.
        expect(row.placementOpen.value).toBe(true);
    });
});

describe(`where the chat runs`, () => {
    it(`is here, a paired runner, or another box by the name the roster gives it`, () => {
        const { chat, row } = rowOf();
        expect(row.placementShown.value).toBe(false);
        expect(row.placementLabel.value).toBe(`Here`);

        chat.runner.value = `studio-mac`;
        expect(row.placementShown.value).toBe(true);
        expect(row.placementLabel.value).toBe(`studio-mac`);

        chat.box.value = `box-2`;
        expect(row.placementLabel.value).toBe(`another sandbox`);
    });

    it(`is offered once there is a runner to choose`, () => {
        const { row } = rowOf();

        runners.value = [RunnerSummarySchema.parse({ id: `r1`, online: true, parity: `unknown` })];

        expect(row.placementShown.value).toBe(true);
    });
});

describe(`the pills' words`, () => {
    it(`names the trial as no vendor's`, () => {
        const { chat, row } = rowOf();
        expect(row.onTrial.value).toBe(false);

        chat.selection.apply({ kind: `set`, picks: { provider: TRIAL_PROVIDER } });

        expect(row.onTrial.value).toBe(true);
    });
});
