import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { type PermissionMode, type RunnerSummary, RunnerSummarySchema, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { computed, createApp, h, nextTick, ref } from "vue";
import * as useAgentsOriginal from "../../../../agents/fleet/useAgents";
import * as useRunnersOriginal from "../../../../sandbox/devices/runners/useRunners";
import type { RunThroughState } from "../../../models/run-settings/useRunThrough";
import type { ChatMessage } from "../../../transcript/transcript";

// Pins the composer's row: a control waits in the overflow while it is at this chat's default and rides the row once
// set, the overflow hands off to the picker that owns the choice, and an armed edit or a workflow badge takes back
// whatever else would rewrite what Send means.

// The runners this sandbox has paired and the roster's entries, as the row reads them.
const { runners, rostered } = await (async () => {
    const { ref: vueRef } = await import(`vue`);
    return { runners: vueRef<RunnerSummary[]>([]), rostered: vueRef<readonly string[]>([]) };
})();
// Held before the mocks replace the modules' bindings, which would otherwise answer with the mocks themselves.
const { useAgents } = useAgentsOriginal;
jest.mock("../../../../agents/fleet/useAgents", () => ({
    ...useAgentsOriginal,
    useAgents: () => ({ ...useAgents(), agentById: (id: string) => (rostered.value.includes(id) ? { id, status: `idle` } : undefined) }),
}));
jest.mock("../../../../sandbox/devices/runners/useRunners", () => ({ ...useRunnersOriginal, useRunners: () => ({ runners }) }));

const { useComposerControls } = await import("../composerControls");
const { Conversation } = await import("../../../session/conversation");

let unmount: (() => void) | undefined;
const rowOf = () => {
    const chat = new Conversation(`c1`);
    // An isolated chat's own untouched posture.
    const mode = ref<PermissionMode>(`bypassPermissions`);
    const runState = ref<RunThroughState>(`idle`);
    const runThrough = { open: ref(false), state: computed(() => runState.value), clear: jest.fn() };
    const steered = ref(false);
    const editing = ref<ChatMessage | undefined>();
    const pills = {
        mode: ref<HTMLElement>(document.createElement(`button`)),
        placement: ref<HTMLElement>(document.createElement(`button`)),
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
        expect(keys(row)).toEqual([`mode`, `persona`, `runThrough`, `land`]);
        expect(row.inRow.value).toEqual({ mode: false, placement: false, persona: false, runThrough: false, voice: false, land: false });
        expect(row.laterOffered.value).toBe(true);

        mode.value = `plan`;
        chat.selection.apply({ kind: `set`, picks: { actsAs: `backend` } });
        chat.autoLandDraft.value = true;
        expect(keys(row)).toEqual([`runThrough`]);
        expect(row.inRow.value).toEqual({ mode: true, placement: false, persona: true, runThrough: false, voice: false, land: true });

        // A loop takes the send somewhere a booking cannot follow: the send's caret offers no later then.
        runState.value = `loop`;
        expect(keys(row)).toEqual([]);
        expect(row.inRow.value).toEqual({ mode: true, placement: false, persona: true, runThrough: true, voice: false, land: true });
        expect(row.laterOffered.value).toBe(false);
    });

    it(`offers writing as the agent once the chat has somewhere to place the words`, () => {
        const { chat, row } = rowOf();
        expect(keys(row)).not.toContain(`voice`);

        // On the roster: the daemon has an entry to place into, whatever this tab has latched.
        rostered.value = [`c1`];
        expect(keys(row)).toEqual([`mode`, `persona`, `runThrough`, `voice`, `land`]);

        // Registered, landing is the card's to answer: with no card on its branch in this window, it is not offered.
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

    it(`hands a row to the picker that owns it, closing itself first; the voice and landing rows are the press`, () => {
        const { chat, runThrough, row } = rowOf();
        const picks = [`mode`, `placement`, `persona`, `runThrough`, `voice`, `land`] as const;
        for (const control of picks) {
            row.moreOpen.value = true;
            row.openFromMore(control);
            expect(row.moreOpen.value, control).toBe(false);
        }

        expect(row.modeOpen.value).toBe(true);
        expect(row.placementOpen.value).toBe(true);
        expect(row.personaOpen.value).toBe(true);
        expect(runThrough.open.value).toBe(true);
        expect(row.voiceAgent.value).toBe(true);
        // Unregistered, the chat holds its own answer until its opening message carries it.
        expect(chat.autoLandDraft.value).toBe(true);
    });

    it(`opens a picker over its own chip while that rides the row, and over the overflow button otherwise`, () => {
        const { mode, pills, row } = rowOf();
        expect(row.modeAnchor.value).toBe(pills.more.value);

        mode.value = `plan`;

        expect(row.modeAnchor.value).toBe(pills.mode.value);
    });
});

describe(`what Send means`, () => {
    it(`drops the agent's voice, both run-through picks and a time picked once an edit is armed`, async () => {
        const { chat, editing, runThrough, row } = rowOf();
        row.voiceAgent.value = true;
        chat.sendLater.value = { kind: `after`, conversationId: `brave-otter` };

        editing.value = { id: 1, role: `user`, text: `first` };
        await nextTick();

        expect(row.voiceAgent.value).toBe(false);
        expect(runThrough.clear).toHaveBeenCalledTimes(1);
        expect(chat.sendLater.value).toBeUndefined();
    });

    it(`gives a workflow badge the composer: the voice disarms and the panels its greyed pills open close`, async () => {
        const { steered, row } = rowOf();
        for (const open of [row.voiceAgent, row.modelOpen, row.modeOpen, row.personaOpen, row.laterOpen, row.moreOpen, row.placementOpen]) {
            open.value = true;
        }

        steered.value = true;
        await nextTick();

        expect([row.voiceAgent, row.modelOpen, row.modeOpen, row.personaOpen, row.laterOpen, row.moreOpen].map((open) => open.value)).toEqual([
            false,
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

    it(`waits in the overflow while it is here, and opens over the overflow button`, () => {
        const { pills, row } = rowOf();
        expect(keys(row)).not.toContain(`placement`);

        runners.value = [RunnerSummarySchema.parse({ id: `r1`, online: true, parity: `unknown` })];

        expect(keys(row)).toEqual([`mode`, `placement`, `persona`, `runThrough`, `land`]);
        expect(row.inRow.value.placement).toBe(false);
        expect(row.moreRows.value.find((entry) => entry.key === `placement`)).toMatchObject({ label: `Where this runs`, value: `This sandbox` });
        expect(row.placementAnchor.value).toBe(pills.more.value);

        row.openFromMore(`placement`);
        expect(row.placementOpen.value).toBe(true);
    });

    it(`rides the row as a chip once the chat is placed elsewhere, and opens over it`, () => {
        const { chat, pills, row } = rowOf();
        runners.value = [RunnerSummarySchema.parse({ id: `r1`, online: true, parity: `unknown` })];

        chat.runner.value = `r1`;

        expect(row.inRow.value.placement).toBe(true);
        expect(keys(row)).not.toContain(`placement`);
        expect(row.placementAnchor.value).toBe(pills.placement.value);

        // Another box is the same: the chip names where the chat went, so it is never out of sight.
        chat.runner.value = undefined;
        chat.box.value = `box-2`;
        expect(row.inRow.value.placement).toBe(true);
    });

    it(`stays in the overflow once the board has seen the chat, where the menu says why it cannot move`, () => {
        const { chat, row } = rowOf();
        runners.value = [RunnerSummarySchema.parse({ id: `r1`, online: true, parity: `unknown` })];

        chat.registered.value = true;
        expect(keys(row)).toContain(`placement`);
        expect(row.inRow.value.placement).toBe(false);

        chat.runner.value = `r1`;
        expect(row.inRow.value.placement).toBe(true);
        expect(keys(row)).not.toContain(`placement`);
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
