import { resetSandboxScope } from "@intentic/extension-api";
import type { ContextUsage, TurnFact } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { computed, reactive, ref } from "vue";
import { selectedAccountId } from "../accounts/providerAccounts";
import { modelLabelFor, providerTabs } from "../accounts/providerCatalog";
import { AUTO_PROVIDER } from "../models/modelPickerState";
import { turnDefaults } from "../run/turnDefaults";
import type { SessionRef } from "../run/turnRequest";
import { ComposerSelection, midTurnSwitchText, modelSwitchText, segmentSwitchText, type SwitchPoint, switchNoticeText } from "./composerSelection";
import { type TranscriptHost, TranscriptView } from "./transcriptView";

// Pins what the next turn runs on and the one divider a change of it owes: which picks wait out a live turn, what a
// switch retires, what the app moves and gives back, and the words, against a conversation that is only its refs.

const providerName = (provider: string): string | undefined => providerTabs.find((tab) => tab.value === provider)?.label;
const FRESH = (name: string | undefined): string =>
    `Switched to ${name}: your next message starts a fresh session with the conversation so far carried over.`;

// The session a first turn on Claude minted, on account `a1`.
const CLAUDE_SESSION: SessionRef = { id: `s-1`, provider: `claude`, account: `a1`, harness: `native` };

// A selection over a conversation that is nothing but the refs it reads and writes; `live` is the turn's state, set by
// the test. The transcript is a real one, since the divider is rows in it.
const selectionOf = () => {
    const live = reactive({ streaming: false, generating: false });
    const transcript = new TranscriptView(() => undefined, unstubbed<TranscriptHost>(`transcriptHost`, {}));
    const host = {
        session: ref<SessionRef | undefined>(),
        activeModel: ref<string | null>(`reported-model`),
        contextUsage: ref<ContextUsage | undefined>({ tokens: 10, contextWindow: 100 }),
        fastMode: ref<Extract<TurnFact, { kind: `fast_mode` }> | undefined>({ kind: `fast_mode`, state: `on` }),
        transcript,
        box: ref<string | undefined>(),
        turn: { streaming: computed(() => live.streaming), generating: computed(() => live.generating) },
        peek: ref(true),
    };
    const notices = (): string[] => transcript.messages.value.filter((message) => message.role === `notice`).map((message) => message.text);
    return { live, host, notices, selection: new ComposerSelection(host) };
};

const seedTurnDefaults = (): void => {
    turnDefaults.provider.value = `claude`;
    turnDefaults.models.value = { claude: `opus`, codex: `gpt-5-codex`, grok: `` };
    turnDefaults.harness.value = `native`;
    turnDefaults.effort.value = `high`;
    turnDefaults.thinking.value = true;
    turnDefaults.auto.value = false;
};

beforeEach(() => {
    seedTurnDefaults();
    selectedAccountId.value = { ...selectedAccountId.value, claude: `a1` };
});
afterEach(() => {
    resetSandboxScope();
    seedTurnDefaults();
});

describe(`the words a switch owes`, () => {
    // A chat that ran a turn on Opus and is now pointed at Haiku on another provider.
    const MOVED: SwitchPoint = {
        started: true,
        resumes: false,
        providerLabel: `Codex`,
        sentModel: `opus`,
        model: `haiku`,
        modelLabel: `Haiku`,
        allowance: ``,
    };

    it(`a segment switch says the session starts fresh, once anything has happened and only if it no longer resumes`, () => {
        expect(segmentSwitchText(MOVED)).toBe(FRESH(`Codex`));
        expect(segmentSwitchText({ ...MOVED, started: false })).toBeUndefined();
        expect(segmentSwitchText({ ...MOVED, resumes: true })).toBeUndefined();
    });

    it(`a model swap names the model and its allowance, and nothing before a send or back where the last one ran`, () => {
        expect(modelSwitchText({ ...MOVED, allowance: ` · Opus 61% used` })).toBe(`Switched to Haiku · Opus 61% used`);
        expect(modelSwitchText({ ...MOVED, sentModel: undefined })).toBeUndefined();
        expect(modelSwitchText({ ...MOVED, sentModel: `haiku` })).toBeUndefined();
    });

    it(`the pending divider is the segment's words when both apply`, () => {
        expect(switchNoticeText(MOVED)).toBe(FRESH(`Codex`));
        expect(switchNoticeText({ ...MOVED, resumes: true })).toBe(`Switched to Haiku`);
        expect(switchNoticeText({ ...MOVED, resumes: true, sentModel: `haiku` })).toBeUndefined();
    });

    it(`a settle speaks for a segment switch only when one was made during the turn`, () => {
        expect(midTurnSwitchText(MOVED, true)).toBe(FRESH(`Codex`));
        expect(midTurnSwitchText(MOVED, false)).toBe(`Switched to Haiku`);
        expect(midTurnSwitchText({ ...MOVED, sentModel: `haiku` }, false)).toBeUndefined();
    });
});

describe(`ComposerSelection`, () => {
    it(`starts a chat on the remembered picks`, () => {
        const { selection } = selectionOf();

        expect(selection.provider.value).toBe(`claude`);
        expect(selection.model.value).toBe(`opus`);
        expect(selection.account.value).toBe(`a1`);
        expect(selection.effortPick.value).toBe(`high`);
        expect(selection.thinking.value).toBe(true);
        expect(selection.auto.value).toBe(false);
        expect(selection.movedFrom.value).toBeUndefined();
    });

    it(`a provider switch re-scopes the picks, forgets what the old segment reported, and is remembered`, () => {
        const { selection, host } = selectionOf();

        selection.apply({ kind: `selectProvider`, provider: `codex` });

        expect(selection.provider.value).toBe(`codex`);
        expect(selection.model.value).toBe(`gpt-5-codex`);
        expect(host.activeModel.value).toBeNull();
        expect(host.contextUsage.value).toBeUndefined();
        expect(host.peek.value).toBe(false);
        expect(turnDefaults.provider.value).toBe(`codex`);
    });

    it(`waits out a live turn for every pick but the account, which waits only while the model generates`, () => {
        const { selection, live, host } = selectionOf();
        live.streaming = true;

        selection.apply({ kind: `selectProvider`, provider: `codex` });
        selection.apply({ kind: `selectModel`, pick: { provider: `codex`, value: `gpt-5-codex` } });
        selection.apply({ kind: `selectHarness`, harness: `claude-code` });
        selection.apply({ kind: `setAuto`, auto: true });
        selection.apply({ kind: `wearModel`, pin: { provider: `claude`, model: `haiku` } });
        expect(selection.provider.value).toBe(`claude`);
        expect(selection.model.value).toBe(`opus`);
        expect(selection.harness.value).toBe(`native`);
        expect(selection.auto.value).toBe(false);

        live.generating = true;
        selection.apply({ kind: `selectAccount`, account: `a2` });
        expect(selection.account.value).toBe(`a1`);
        // Nothing refused was done to the chat, so it is still only being looked at.
        expect(host.peek.value).toBe(true);

        // Parked on a card: the turn keeps its credential, the next one takes the new pick.
        live.generating = false;
        selection.apply({ kind: `selectAccount`, account: `a2` });
        expect(selection.account.value).toBe(`a2`);
        expect(host.peek.value).toBe(false);
    });

    it(`holds a divider for an account switched during the turn until the turn settles`, () => {
        const { selection, live, host, notices } = selectionOf();
        host.session.value = CLAUDE_SESSION;
        live.streaming = true;

        selection.apply({ kind: `selectAccount`, account: `a2` });
        expect(notices()).toEqual([]);

        live.streaming = false;
        selection.apply({ kind: `settled` });
        expect(notices()).toEqual([FRESH(providerName(`claude`))]);
        // Owed once: a second settle has nothing more to say.
        selection.apply({ kind: `settled` });
        expect(notices()).toEqual([FRESH(providerName(`claude`))]);
    });

    it(`keeps one divider for the next send, reworded as picks move and gone once they come back`, () => {
        const { selection, host, notices } = selectionOf();
        host.session.value = CLAUDE_SESSION;

        selection.apply({ kind: `selectAccount`, account: `a2` });
        expect(notices()).toEqual([FRESH(providerName(`claude`))]);
        selection.apply({ kind: `selectProvider`, provider: `codex` });
        expect(notices()).toEqual([FRESH(providerName(`codex`))]);

        // Back on the session's own runtime, which restores its account, so the next send resumes it.
        selection.apply({ kind: `selectProvider`, provider: `claude` });
        expect(selection.account.value).toBe(`a1`);
        expect(notices()).toEqual([]);
    });

    it(`measures a model swap against the model the last turn was sent on`, () => {
        const { selection, host, notices } = selectionOf();
        host.session.value = CLAUDE_SESSION;

        // Nothing sent on this segment yet: a pick here costs nothing to say.
        selection.apply({ kind: `selectModel`, pick: { provider: `claude`, value: `haiku` } });
        expect(notices()).toEqual([]);

        selection.apply({ kind: `sent` });
        selection.apply({ kind: `selectModel`, pick: { provider: `claude`, value: `sonnet` } });
        expect(notices()).toEqual([`Switched to ${modelLabelFor(`claude`, `sonnet`)}`]);

        // A send freezes it into the record; the next swap is measured from the model that send went out on.
        selection.apply({ kind: `sent` });
        selection.apply({ kind: `selectModel`, pick: { provider: `claude`, value: `sonnet` } });
        expect(notices()).toEqual([`Switched to ${modelLabelFor(`claude`, `sonnet`)}`]);
    });

    it(`arms Auto without moving the chat, and a model named by hand or by a card disarms it`, () => {
        const { selection } = selectionOf();

        selection.apply({ kind: `selectModel`, pick: { provider: AUTO_PROVIDER, value: `` } });
        expect(selection.auto.value).toBe(true);
        expect(selection.model.value).toBe(`opus`);

        selection.apply({ kind: `wearModel`, pin: { provider: `claude`, model: `haiku`, effort: `low`, thinking: false } });
        expect(selection.auto.value).toBe(false);
        expect(selection.model.value).toBe(`haiku`);
        expect(selection.effortPick.value).toBe(`low`);
        expect(selection.thinking.value).toBe(false);
    });

    it(`owes back a model a catalog displaced, until the user picks one of their own`, () => {
        const { selection } = selectionOf();

        selection.apply({ kind: `displaceModel`, model: `haiku` });
        selection.apply({ kind: `displaceModel`, model: `sonnet` });
        // Owed the user's pick, not the stand-in it passed through.
        expect(selection.displacedModel.value).toBe(`opus`);
        selection.apply({ kind: `restoreModel` });
        expect(selection.model.value).toBe(`opus`);
        expect(selection.displacedModel.value).toBeUndefined();

        selection.apply({ kind: `displaceModel`, model: `haiku` });
        selection.apply({ kind: `selectModel`, pick: { provider: `claude`, value: `sonnet` } });
        selection.apply({ kind: `restoreModel` });
        expect(selection.model.value).toBe(`sonnet`);
    });

    it(`gives back the provider the app moved the chat off, but not mid-turn`, () => {
        const { selection, live } = selectionOf();

        selection.apply({ kind: `repointProvider`, provider: `codex` });
        selection.apply({ kind: `repointProvider`, provider: `grok` });
        // The first pick it moved off is what is owed, not the stop in between.
        expect(selection.movedFrom.value).toEqual({ provider: `claude`, value: `opus` });
        // Not a pick: the next new chat still starts where the user left it.
        expect(turnDefaults.provider.value).toBe(`claude`);

        live.streaming = true;
        selection.apply({ kind: `restoreProvider` });
        expect(selection.provider.value).toBe(`grok`);

        live.streaming = false;
        selection.apply({ kind: `restoreProvider` });
        expect(selection.provider.value).toBe(`claude`);
        expect(selection.model.value).toBe(`opus`);
        expect(selection.movedFrom.value).toBeUndefined();
    });

    it(`moves the held session onto a reconnected credential without calling it a switch`, () => {
        const { selection, host, notices } = selectionOf();
        host.session.value = CLAUDE_SESSION;
        selection.apply({ kind: `selectAccount`, account: `a2` });
        expect(notices()).toEqual([FRESH(providerName(`claude`))]);

        selection.apply({ kind: `rebindAccount`, account: `a3` });

        expect(selection.account.value).toBe(`a3`);
        expect(host.session.value).toEqual({ ...CLAUDE_SESSION, account: `a3` });
        expect(notices()).toEqual([]);
    });

    it(`spends the Auto mark on the one turn it decided, and asks for fast speed only where it is offered`, () => {
        const { selection } = selectionOf();
        selection.apply({ kind: `set`, picks: { autoPicked: true, actsAs: `backend`, startIn: `api` } });
        selection.apply({ kind: `setFast`, fast: true });

        expect(selection.turnSettings()).toEqual({
            agent: `claude`,
            harness: `native`,
            account: `a1`,
            actsAs: `backend`,
            startIn: `api`,
            model: `opus`,
            effort: selection.effort.value,
            thinking: true,
            fast: selection.fastOffered.value,
            autoPicked: true,
        });
        expect(selection.turnSettings().autoPicked).toBeUndefined();
    });

    it(`drops the last speed answer when the fast pick changes`, () => {
        const { selection, host } = selectionOf();

        selection.apply({ kind: `setFast`, fast: true });

        expect(selection.fast.value).toBe(true);
        expect(host.fastMode.value).toBeUndefined();
    });

    it(`hands a fork the source's picks, not what they clamp to, and no session`, () => {
        const source = selectionOf().selection;
        source.apply({ kind: `selectModel`, pick: { provider: `claude`, value: `haiku` } });
        source.apply({ kind: `setEffort`, effort: `max` });
        source.apply({ kind: `setThinking`, thinking: false });
        source.apply({ kind: `set`, picks: { modePick: `plan` } });
        const { selection, host } = selectionOf();

        selection.apply({ kind: `adopt`, from: source.state.value });

        expect(selection.model.value).toBe(`haiku`);
        expect(selection.effortPick.value).toBe(`max`);
        expect(selection.thinking.value).toBe(false);
        expect(selection.modePick.value).toBe(`plan`);
        expect(host.session.value).toBeUndefined();
    });

    it(`resumes a history session on Claude's remembered account, planning before it touches anything`, () => {
        const { selection, host } = selectionOf();
        selection.apply({ kind: `selectProvider`, provider: `codex` });

        selection.apply({ kind: `resumeHistory`, sessionId: `s-9` });

        expect(host.session.value).toEqual({ id: `s-9`, provider: `claude`, account: `a1`, harness: `native` });
        expect(selection.provider.value).toBe(`claude`);
        expect(selection.modePick.value).toBe(`plan`);
    });
});
