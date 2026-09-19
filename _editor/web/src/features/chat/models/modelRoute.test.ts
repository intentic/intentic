import { pinnedModelLabel } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { effectScope, type EffectScope, ref } from "vue";

// Pins the composer's half of Auto: that nothing is read until the message is sent, that it is read once and never
// again, that the chat says so while the reading runs and what it cost when it lands, and what a send does with the
// answer. The daemon's own choosing is not what this tests.

const sandboxJson = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
vi.mock(`../../sandbox/client/sandboxClient`, () => ({ sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init) }));

const { SEND_WAIT_MS, modelRouteWait, useModelRoute } = await import("./modelRoute");
type Chat = Parameters<typeof useModelRoute>[0] extends () => infer C ? C : never;

// Only the fields Auto reads and writes; a real Conversation drags a transcript and stream along. `notice`/`reword`
// stand in for the transcript rows the chat writes about the reading.
const wearModel = vi.fn();
const notice = vi.fn<(text: string, extra?: { noticeWait?: string }) => number>(() => 7);
const reword = vi.fn<(id: number, text: string, extra?: { noticeWait?: string }) => void>();
const setAuto = vi.fn();
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
const PICK = { provider: `claude`, model: `claude-opus-5`, effort: `high`, account: `work` };

// `null` is the answer that reached no model at all, which an explicit `undefined` could not be: a default parameter
// takes it back.
const answer = (pick: Record<string, unknown> | undefined, reason = `because`, judge: string | null = `${JUDGE_PIN.provider}:${JUDGE_PIN.model}`) =>
    sandboxJson.mockResolvedValueOnce({ ...(pick === undefined ? {} : { pick }), reason, ...(judge === null ? {} : { judge }) });
const sent = (call = 0): { prompt: string; paths: string[]; planMode: boolean } =>
    JSON.parse(String(sandboxJson.mock.calls[call]?.[1]?.body)) as { prompt: string; paths: string[]; planMode: boolean };
const verdict = (): string => String(reword.mock.calls.at(-1)?.[1]);

// Each test's composables run in a scope stopped afterward, as a pane's would be on unmount.
let scope: EffectScope;
const route = (chat: Chat): ReturnType<typeof useModelRoute> => scope.run(() => useModelRoute(() => chat))!;

beforeEach(() => {
    vi.useFakeTimers();
    scope = effectScope();
});
afterEach(() => {
    scope.stop();
    vi.useRealTimers();
    sandboxJson.mockReset();
    wearModel.mockReset();
    setAuto.mockReset();
    notice.mockClear();
    reword.mockClear();
});

test("a chat that is not on Auto is never read, and costs nothing", async () => {
    const chat = chatWith({ auto: ref(false) });
    expect(route(chat).beforeSend(`fix the billing totals`, false)).toBeUndefined();
    expect(sandboxJson).not.toHaveBeenCalled();
});

test("the sent message is read once, and the answer is worn as if it had been picked by hand", async () => {
    answer(PICK);
    const chat = chatWith();
    await route(chat).beforeSend(`the invoice totals are off in billing`, false);
    expect(sent().prompt).toBe(`the invoice totals are off in billing`);
    expect(wearModel).toHaveBeenCalledWith({ provider: `claude`, model: `claude-opus-5`, effort: `high` });
    // After wearModel, never before: pointing at a provider re-scopes the account, which would throw this one away.
    expect(chat.account.value).toBe(`work`);
    // Marks the one turn the judge decided, so the ledger can later be asked whether the choice held.
    expect(chat.autoPicked.value).toBe(true);
});

test("a turn the judge did not decide carries no mark", async () => {
    answer(undefined, `Couldn't choose a model for this chat, so it keeps the one it had.`);
    const chat = chatWith();
    await route(chat).beforeSend(`the invoice totals are off in billing`, false);
    expect(chat.autoPicked.value).toBe(false);
});

test("a second message never buys another reading", async () => {
    answer(PICK);
    const chat = chatWith();
    const routing = route(chat);
    await routing.beforeSend(`the invoice totals are off in billing`, false);
    expect(routing.beforeSend(`now do the same for the other file`, false)).toBeUndefined();
    expect(sandboxJson).toHaveBeenCalledTimes(1);
});

test("a chat already under way disarms Auto instead of leaving a question nothing will answer", () => {
    const chat = chatWith({ messages: ref([{ id: 1 }]) });
    expect(route(chat).beforeSend(`carry on`, false)).toBeUndefined();
    expect(setAuto).toHaveBeenCalledWith(false);
    expect(sandboxJson).not.toHaveBeenCalled();
});

test("a greeting is not a description of work, and is not worth a reading", () => {
    const chat = chatWith();
    expect(route(chat).beforeSend(`hi`, false)).toBeUndefined();
    expect(setAuto).toHaveBeenCalledWith(false);
    expect(sandboxJson).not.toHaveBeenCalled();
});

test("the chat says the reading is happening, then what it cost, in one row", async () => {
    answer(PICK, `Read the opening message as work for Opus 5.`);
    const chat = chatWith();
    const pending = route(chat).beforeSend(`the invoice totals are off in billing`, false);
    // While it runs the row spins on a wait the view asks this module about.
    expect(notice).toHaveBeenCalledWith(expect.stringContaining(`Choosing which model this chat runs on`), { noticeWait: `modelRoute` });
    expect(modelRouteWait(chat)).toMatchObject({ since: expect.any(Number) });
    await pending;
    expect(modelRouteWait(chat)).toBeUndefined();
    expect(verdict()).toBe(`Read the opening message as work for Opus 5. Every turn after this one stays on it until you change it. Read by ${JUDGE_LABEL}.`);
    expect(reword).toHaveBeenCalledWith(7, expect.any(String), { noticeWait: undefined });
});

test("an answer that named no model is still reported: the call was paid for either way", async () => {
    answer(undefined, `Couldn't choose a model for this chat, so it keeps the one it had.`);
    const chat = chatWith();
    await route(chat).beforeSend(`the invoice totals are off in billing`, false);
    expect(wearModel).not.toHaveBeenCalled();
    expect(verdict()).toBe(`Couldn't choose a model for this chat, so it keeps the one it had. Read by ${JUDGE_LABEL}.`);
});

test("a reading nothing was spent on names no model as having read it", async () => {
    answer(undefined, `Nothing connected can run a turn right now, so this chat keeps the model it had.`, null);
    const chat = chatWith();
    await route(chat).beforeSend(`the invoice totals are off in billing`, false);
    expect(verdict()).toBe(`Nothing connected can run a turn right now, so this chat keeps the model it had.`);
});

test("a send is not held past the wait: a slow reading loses, and the chat runs on its own pick", async () => {
    sandboxJson.mockReturnValue(new Promise(() => undefined));
    const chat = chatWith();
    const pending = route(chat).beforeSend(`the invoice totals are off in billing`, false);
    await vi.advanceTimersByTimeAsync(SEND_WAIT_MS);
    await pending;
    expect(wearModel).not.toHaveBeenCalled();
    expect(verdict()).toBe(`Couldn't choose a model for this chat in time, so it runs on the one it already had.`);
});

test("a failed call reads as no answer rather than an error", async () => {
    sandboxJson.mockRejectedValue(new Error(`offline`));
    const chat = chatWith();
    await route(chat).beforeSend(`the invoice totals are off in billing`, false);
    expect(wearModel).not.toHaveBeenCalled();
    expect(setAuto).toHaveBeenCalledWith(false);
});

test("a hand on the picker while the reading ran is the last word", async () => {
    answer(PICK);
    const chat = chatWith();
    const pending = route(chat).beforeSend(`the invoice totals are off in billing`, false);
    // Exactly what selectModel does: naming a model answers the question Auto was armed to ask.
    chat.auto.value = false;
    await pending;
    expect(wearModel).not.toHaveBeenCalled();
});

test("plan mode and the editor chip ride along: facts the words alone cannot carry", async () => {
    answer(PICK);
    const chat = chatWith({ modePick: ref(`plan`) });
    await route(chat).beforeSend(`the invoice totals are off in billing`, true);
    expect(sent()).toMatchObject({ planMode: true, editorContext: true });
});
