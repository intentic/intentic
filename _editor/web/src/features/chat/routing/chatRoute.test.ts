import type { SandboxSettings } from "@intentic/api-contract";
import { SandboxSettingsSchema } from "@intentic/api-contract";
import { type Persona, pinnedModelLabel } from "@intentic/sandbox-contract";
import { test, expect, beforeEach, afterEach, mock, jest } from "bun:test";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { effectScope, type EffectScope, ref } from "vue";

// Pins the composer's half of routing: that nothing is read until the message is sent, that ONE call answers whichever
// halves the chat still has open, that the chat says so while the reading runs and what it cost when it lands, and
// what a send does with the answer. The daemon's own choosing is not what this tests.

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
mock.module(`../../sandbox/overview/useSandboxSettings`, () => ({ useSandboxSettings: () => ({ settings }) }));

// `backend` names its own model, `social` names none: the two cases that decide whether a routed persona answers the
// model question itself.
const personas = ref<Persona[]>([
    {
        id: `backend`,
        label: `Backend`,
        capabilities: [],
        brief: `Backend work.`,
        context: { repos: [`api`] },
        models: [{ provider: `claude`, model: `claude-opus-5`, effort: `max` }],
    },
    { id: `social`, capabilities: [] },
]);
mock.module(`../../sandbox/personas/usePersonas`, () => ({ usePersonas: () => ({ personas }) }));

// A guest is never routed onto a persona: its chat wears one of its own from the start.
const isGuest = ref(false);
mock.module(`../../sandbox/secrets/useRole`, () => ({ useRole: () => ({ isGuest }) }));

const sandboxJson = mock<(path: string, init?: RequestInit) => Promise<unknown>>();
mock.module(`../../sandbox/client/sandboxClient`, () => ({ sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init) }));

// Claude connected, nothing else: the backend persona's ladder resolves to its one pin.
mock.module(`../accounts/roleModel`, () => ({ roleSources: ref([{ provider: `claude`, ready: true, models: [] }]) }));

const { SEND_WAIT_MS, chatRouteWait, useChatRoute } = await import("./chatRoute");
type Chat = Parameters<typeof useChatRoute>[0] extends () => infer C ? C : never;

// Only the fields routing reads and writes; a real Conversation drags a transcript and stream along. `notice`/`reword`
// stand in for the transcript rows the chat writes about the reading.
const wearModel = mock();
const notice = mock<(text: string, extra?: { noticeWait?: string }) => number>(() => 7);
const reword = mock<(id: number, text: string, extra?: { noticeWait?: string }) => void>();
const setAuto = mock();
const chatWith = (over: Record<string, unknown> = {}): Chat => {
    const auto = ref(true);
    setAuto.mockImplementation((value: boolean) => {
        auto.value = value;
    });
    return {
        auto,
        autoPicked: ref(false),
        box: ref(undefined),
        messages: ref([]),
        actsAs: ref(undefined),
        attachments: ref([]),
        account: ref(undefined),
        modePick: ref(`bypassPermissions`),
        wearModel,
        setAuto,
        notice,
        reword,
        ...over,
    } as unknown as Chat;
};

// A pin the static catalog knows, so the sentence under test carries the label a reader would actually see.
const JUDGE_PIN = { provider: `claude`, model: `claude-haiku-4-5-20251001` };
const JUDGE_LABEL = pinnedModelLabel(JUDGE_PIN);
const JUDGE = `${JUDGE_PIN.provider}:${JUDGE_PIN.model}`;
const PICK = { provider: `claude`, model: `claude-opus-5`, effort: `high`, account: `work` };
const WORK = `the invoice totals are off in billing`;

// One answer, in the shape the daemon sends it: a half that was not asked about is absent, not empty.
const answer = (route: Record<string, unknown>) => sandboxJson.mockResolvedValueOnce({ judge: JUDGE, ...route });
const sent = (call = 0): Record<string, unknown> => JSON.parse(String(sandboxJson.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;
const verdict = (): string => String(reword.mock.calls.at(-1)?.[1]);

// Each test's composables run in a scope stopped afterward, as a pane's would be on unmount.
let scope: EffectScope;
const route = (chat: Chat): ReturnType<typeof useChatRoute> => scope.run(() => useChatRoute(() => chat))!;

beforeEach(() => {
    jest.useFakeTimers();
    scope = effectScope();
});
afterEach(() => {
    scope.stop();
    jest.useRealTimers();
    settings.value = SandboxSettingsSchema.parse({});
    isGuest.value = false;
    sandboxJson.mockReset();
    wearModel.mockReset();
    setAuto.mockReset();
    notice.mockClear();
    reword.mockReset();
});

test("both questions open: one call asks for both, and nothing is read until the message is sent", async () => {
    expect(settings.value.personaRouting).toBe(true);
    const chat = chatWith({ attachments: ref([{ path: `docs/spec.md` }]) });
    const text = `the invoice totals are off in @api/src/totals.ts`;
    answer({
        persona: { id: `social`, reason: `The message reads like social's work.` },
        model: { pick: PICK, reason: `Read the opening message as work for Opus 5.` },
    });
    const routing = route(chat);

    // A whole session of typing, and nothing has been asked of any model.
    await advanceTimersByTimeAsync(60_000);
    expect(sandboxJson).not.toHaveBeenCalled();

    await routing.beforeSend(text, false);
    expect(sandboxJson).toHaveBeenCalledTimes(1);
    expect(sandboxJson.mock.calls[0]?.[0]).toBe(`/agent/route-chat`);
    expect(sent()).toMatchObject({ prompt: text, paths: [`docs/spec.md`, `api/src/totals.ts`], model: true, persona: true });
    // A persona with no model of its own leaves the model question to the reading's own pick.
    expect(chat.actsAs.value).toBe(`social`);
    expect(wearModel).toHaveBeenCalledWith({ provider: `claude`, model: `claude-opus-5`, effort: `high` });
    expect(chat.account.value).toBe(`work`);
    expect(chat.autoPicked.value).toBe(true);
    expect(verdict()).toBe(
        `Acting as social. The message reads like social's work. Read the opening message as work for Opus 5. Every turn after this one stays on it until you change it. Read by ${JUDGE_LABEL}.`,
    );
});

test("a persona that brings its own model answers the model question itself, and the line says so", async () => {
    const chat = chatWith();
    answer({
        persona: { id: `backend`, reason: `The message reads like Backend's work.` },
        model: { pick: PICK, reason: `Read the opening message as work for Opus 5.` },
    });
    await route(chat).beforeSend(WORK, false);
    expect(chat.actsAs.value).toBe(`backend`);
    expect(wearModel).toHaveBeenCalledTimes(1);
    expect(wearModel).toHaveBeenCalledWith({ provider: `claude`, model: `claude-opus-5`, effort: `max` });
    // The pick the same reading made stands down, so nothing claims a model the chat is not running.
    expect(chat.account.value).toBeUndefined();
    expect(chat.autoPicked.value).toBe(false);
    expect(verdict()).toBe(
        `Acting as Backend. The message reads like Backend's work. Backend brings its own model, so this chat runs on that instead. Read by ${JUDGE_LABEL}.`,
    );
});

test("auto model on, persona matching off: only the model is asked for", async () => {
    settings.value = { ...settings.value, personaRouting: false };
    const chat = chatWith();
    answer({ model: { pick: PICK, reason: `Read the opening message as work for Opus 5.` } });
    await route(chat).beforeSend(WORK, false);
    expect(sent()).toMatchObject({ model: true, persona: false });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining(`Choosing which model this chat runs on`), { noticeWait: `chatRoute` });
    expect(chat.actsAs.value).toBeUndefined();
    expect(verdict()).toBe(
        `Read the opening message as work for Opus 5. Every turn after this one stays on it until you change it. Read by ${JUDGE_LABEL}.`,
    );
});

test("persona matching on, auto model off: only the persona is asked for, and Auto is left as the owner set it", async () => {
    const chat = chatWith({ auto: ref(false) });
    answer({ persona: { id: `backend`, reason: `The message reads like Backend's work.` } });
    await route(chat).beforeSend(WORK, false);
    expect(sent()).toMatchObject({ model: false, persona: true });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining(`Reading which persona this chat belongs to`), { noticeWait: `chatRoute` });
    expect(chat.actsAs.value).toBe(`backend`);
    // Nothing to disarm: Auto was never armed here, and the next new chat's default is not this reading's business.
    expect(setAuto).not.toHaveBeenCalled();
    expect(verdict()).toBe(`Acting as Backend. The message reads like Backend's work. Read by ${JUDGE_LABEL}.`);
});

test("neither question open means no call at all", () => {
    settings.value = { ...settings.value, personaRouting: false };
    expect(route(chatWith({ auto: ref(false) })).beforeSend(WORK, false)).toBeUndefined();
    expect(sandboxJson).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
});

test("the chat says the reading is running, and the row settles in place", async () => {
    const chat = chatWith();
    let resolve!: (value: unknown) => void;
    sandboxJson.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const wait = route(chat).beforeSend(WORK, false);

    expect(notice).toHaveBeenCalledWith(expect.stringContaining(`Reading what this chat opens on`), { noticeWait: `chatRoute` });
    expect(chatRouteWait(chat)).toMatchObject({ since: expect.any(Number) });

    resolve({
        persona: { id: `social`, reason: `The message reads like social's work.` },
        model: { reason: `Couldn't choose a model for this chat, so it keeps the one it had.` },
        judge: JUDGE,
    });
    await wait;
    expect(chatRouteWait(chat)).toBeUndefined();
    expect(reword).toHaveBeenCalledWith(7, expect.any(String), { noticeWait: undefined });
});

test("a half that named nothing is still reported: the call was paid for either way", async () => {
    const chat = chatWith();
    answer({
        persona: { reason: `No persona fits this message.` },
        model: { reason: `Couldn't choose a model for this chat, so it keeps the one it had.` },
    });
    await route(chat).beforeSend(`what is a closure exactly?`, false);
    expect(chat.actsAs.value).toBeUndefined();
    expect(wearModel).not.toHaveBeenCalled();
    expect(chat.autoPicked.value).toBe(false);
    expect(verdict()).toBe(
        `No persona matched, so this chat acts as everyone. No persona fits this message. Couldn't choose a model for this chat, so it keeps the one it had. Read by ${JUDGE_LABEL}.`,
    );
});

test("a reading nothing was spent on names no model as having read it", async () => {
    sandboxJson.mockResolvedValueOnce({ persona: { id: `backend`, reason: `Opened in api, which Backend works in.` } });
    await route(chatWith({ auto: ref(false) })).beforeSend(WORK, false);
    expect(verdict()).toBe(`Acting as Backend. Opened in api, which Backend works in.`);
});

test("a chat already under way disarms Auto instead of leaving a question nothing will answer", () => {
    const chat = chatWith({ messages: ref([{ id: 1 }]) });
    expect(route(chat).beforeSend(`carry on`, false)).toBeUndefined();
    expect(setAuto).toHaveBeenCalledWith(false);
    expect(sandboxJson).not.toHaveBeenCalled();
    // Same for a chat that belongs to another sandbox, or one that has already had its reading.
    expect(route(chatWith({ box: ref(`other-sandbox`) })).beforeSend(WORK, false)).toBeUndefined();
    expect(sandboxJson).not.toHaveBeenCalled();
});

test("each half has its own floor: a short message is still worth a model, and not yet worth a persona", async () => {
    answer({ model: { pick: PICK, reason: `Read the opening message as work for Opus 5.` } });
    await route(chatWith()).beforeSend(`fix it`, false);
    expect(sent()).toMatchObject({ model: true, persona: false });

    // Two characters is not a description of work at all: nothing is read, and Auto disarms rather than standing armed.
    const greeting = chatWith();
    expect(route(greeting).beforeSend(`hi`, false)).toBeUndefined();
    expect(setAuto).toHaveBeenCalledWith(false);
    expect(sandboxJson).toHaveBeenCalledTimes(1);
});

test("a chat pointed at a persona by hand asks only about the model, and a pick by hand overrules the reading", async () => {
    const pinned = chatWith({ actsAs: ref(`social`) });
    answer({ model: { pick: PICK, reason: `Read the opening message as work for Opus 5.` } });
    await route(pinned).beforeSend(WORK, false);
    expect(sent()).toMatchObject({ model: true, persona: false });

    // The pill pressed before the send does the same for the rest of the chat's life.
    const chat = chatWith();
    const routing = route(chat);
    routing.byHand();
    answer({ model: { pick: PICK, reason: `Read the opening message as work for Opus 5.` } });
    await routing.beforeSend(WORK, false);
    expect(sent(1)).toMatchObject({ model: true, persona: false });
});

test("a hand on either control while the reading ran is the last word", async () => {
    const chat = chatWith();
    answer({
        persona: { id: `social`, reason: `The message reads like social's work.` },
        model: { pick: PICK, reason: `Read the opening message as work for Opus 5.` },
    });
    const routing = route(chat);
    const pending = routing.beforeSend(WORK, false);
    // Exactly what selectModel and the persona pill do while the call is out.
    chat.auto.value = false;
    routing.byHand();
    await pending;
    expect(wearModel).not.toHaveBeenCalled();
    expect(chat.actsAs.value).toBeUndefined();
    expect(verdict()).toBe(
        `social matched, but this chat was pointed somewhere by hand first, so nothing moved. Read the opening message as work for Opus 5. Read by ${JUDGE_LABEL}.`,
    );
});

test("a second message never buys another reading", async () => {
    answer({ persona: { id: `social`, reason: `because` }, model: { pick: PICK, reason: `because` } });
    const chat = chatWith();
    const routing = route(chat);
    await routing.beforeSend(WORK, false);
    expect(routing.beforeSend(`now do the same for the other file`, false)).toBeUndefined();
    expect(sandboxJson).toHaveBeenCalledTimes(1);
});

test("a send is not held past the wait, and each half says what the chat keeps instead", async () => {
    sandboxJson.mockReturnValue(new Promise(() => undefined));
    const chat = chatWith();
    const pending = route(chat).beforeSend(WORK, false);
    await advanceTimersByTimeAsync(SEND_WAIT_MS + 1);
    await pending;
    expect(wearModel).not.toHaveBeenCalled();
    expect(chatRouteWait(chat)).toBeUndefined();
    expect(verdict()).toBe(`Couldn't read what this chat opens on in time, so it stays open to everything and runs on the model it already had.`);

    settings.value = { ...settings.value, personaRouting: false };
    const alone = chatWith();
    const second = route(alone).beforeSend(WORK, false);
    await advanceTimersByTimeAsync(SEND_WAIT_MS + 1);
    await second;
    expect(verdict()).toBe(`Couldn't choose a model for this chat in time, so it runs on the one it already had.`);
});

test("a failed call reads as no answer rather than an error", async () => {
    sandboxJson.mockRejectedValue(new Error(`offline`));
    const chat = chatWith();
    await route(chat).beforeSend(WORK, false);
    expect(wearModel).not.toHaveBeenCalled();
    expect(chat.actsAs.value).toBeUndefined();
    expect(setAuto).toHaveBeenCalledWith(false);
});

test("a guest's chat is never asked about personas, whatever the setting says", async () => {
    isGuest.value = true;
    answer({ model: { pick: PICK, reason: `Read the opening message as work for Opus 5.` } });
    await route(chatWith()).beforeSend(WORK, false);
    expect(sent()).toMatchObject({ model: true, persona: false });
});

test("plan mode and the editor chip ride along: facts the words alone cannot carry", async () => {
    answer({ model: { pick: PICK, reason: `because` }, persona: { reason: `No persona fits this message.` } });
    await route(chatWith({ modePick: ref(`plan`) })).beforeSend(WORK, true);
    expect(sent()).toMatchObject({ planMode: true, editorContext: true });
});
