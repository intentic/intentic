import type { SandboxSettings } from "@intentic/api-contract";
import { SandboxSettingsSchema } from "@intentic/api-contract";
import { type Persona, pinnedModelLabel } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { effectScope, type EffectScope, ref } from "vue";

// Pins the composer's half of persona routing: that nothing is read until the message is sent, that the chat says so
// while the reading runs and what it cost when it lands, and what a send does with the answer. The daemon's own
// reading is not what this tests.

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
vi.mock(`../../sandbox/overview/useSandboxSettings`, () => ({ useSandboxSettings: () => ({ settings }) }));

const personas = ref<Persona[]>([
    { id: `backend`, label: `Backend`, capabilities: [], brief: `Backend work.`, context: { repos: [`api`] }, models: [{ provider: `claude`, model: `claude-opus-5`, effort: `max` }] },
    { id: `social`, capabilities: [] },
]);
vi.mock(`../../sandbox/personas/usePersonas`, () => ({ usePersonas: () => ({ personas }) }));

const sandboxJson = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
vi.mock(`../../sandbox/client/sandboxClient`, () => ({ sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init) }));

// Claude connected, nothing else: the backend card's ladder resolves to its one pin.
vi.mock(`../accounts/roleModel`, () => ({ roleSources: ref([{ provider: `claude`, ready: true, models: [] }]) }));

const { SEND_WAIT_MS, personaRouteWait, usePersonaRoute } = await import("./personaRoute");
type Chat = Parameters<typeof usePersonaRoute>[0] extends () => infer C ? C : never;

// Only the fields routing reads and writes; a real Conversation drags a transcript and stream along. `notice`/`reword`
// stand in for the transcript rows the chat writes about the reading.
const wearModel = vi.fn();
const notice = vi.fn<(text: string, extra?: { noticeWait?: string }) => number>(() => 7);
const reword = vi.fn<(id: number, text: string, extra?: { noticeWait?: string }) => void>();
const chatWith = (over: Record<string, unknown> = {}): Chat =>
    ({
        box: ref(undefined),
        messages: ref([]),
        actsAs: ref(undefined),
        attachments: ref([]),
        wearModel,
        notice,
        reword,
        ...over,
    }) as unknown as Chat;

// A pin the static catalog knows, so the sentence under test carries the label a reader would actually see.
const ROUTER_PIN = { provider: `claude`, model: `claude-haiku-4-5-20251001` };
const ROUTER_LABEL = pinnedModelLabel(ROUTER_PIN);
// `null` is the answer that named no model at all, which an explicit `undefined` could not be: a default parameter
// takes it back.
const answer = (persona: string | undefined, reason = `because`, model: string | null = `${ROUTER_PIN.provider}:${ROUTER_PIN.model}`) =>
    sandboxJson.mockResolvedValueOnce({ ...(persona === undefined ? {} : { persona }), reason, ...(model === null ? {} : { model }) });
const sent = (call = 0): { prompt: string; paths: string[] } => JSON.parse(String(sandboxJson.mock.calls[call]?.[1]?.body)) as { prompt: string; paths: string[] };
const verdict = (): string => String(reword.mock.calls.at(-1)?.[1]);

// Each test's composables run in a scope stopped afterward, as a pane's would be on unmount.
let scope: EffectScope;
const route = (chat: Chat): ReturnType<typeof usePersonaRoute> => scope.run(() => usePersonaRoute(() => chat))!;

beforeEach(() => {
    vi.useFakeTimers();
    scope = effectScope();
});
afterEach(() => {
    scope.stop();
    vi.useRealTimers();
    settings.value = SandboxSettingsSchema.parse({});
    sandboxJson.mockReset();
    wearModel.mockReset();
    notice.mockClear();
    reword.mockReset();
});

test("routing is on by default and reads nothing until the message is sent", async () => {
    expect(settings.value.personaRouting).toBe(true);
    const chat = chatWith({ attachments: ref([{ path: `docs/spec.md` }]) });
    const text = `the invoice totals are off in @api/src/totals.ts`;
    answer(`backend`, `The message reads like Backend's work.`);
    const routing = route(chat);

    // A whole session of typing, and nothing has been asked of any model.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sandboxJson).not.toHaveBeenCalled();

    await routing.beforeSend(text);
    expect(sandboxJson).toHaveBeenCalledTimes(1);
    expect(sandboxJson.mock.calls[0]?.[0]).toBe(`/personas/route`);
    expect(sent()).toEqual({ prompt: text, paths: [`docs/spec.md`, `api/src/totals.ts`] });
    expect(chat.actsAs.value).toBe(`backend`);
    expect(wearModel).toHaveBeenCalledWith({ provider: `claude`, model: `claude-opus-5`, effort: `max` });
});

test("the chat says the reading is running, then what it decided and which model was paid for it", async () => {
    const chat = chatWith();
    let resolve!: (value: unknown) => void;
    sandboxJson.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const wait = route(chat).beforeSend(`please fix the login flow`);

    // While it runs: one spinning row, and a clock the row can tick from.
    expect(notice).toHaveBeenCalledWith(expect.stringContaining(`Reading which persona`), { noticeWait: `personaRoute` });
    expect(personaRouteWait(chat)).toMatchObject({ since: expect.any(Number) });

    resolve({ persona: `backend`, reason: `The message reads like Backend's work.`, model: `${ROUTER_PIN.provider}:${ROUTER_PIN.model}` });
    await wait;
    expect(personaRouteWait(chat)).toBeUndefined();
    expect(verdict()).toBe(`Acting as Backend. The message reads like Backend's work. Read by ${ROUTER_LABEL}.`);
    expect(reword.mock.calls.at(-1)?.[2]).toEqual({ noticeWait: undefined });
});

test("a folder match names no model, since nothing was spent on it", async () => {
    answer(`backend`, `Opened in api, which Backend works in.`, null);
    await route(chatWith()).beforeSend(`please fix the login flow`);
    expect(verdict()).toBe(`Acting as Backend. Opened in api, which Backend works in.`);
});

test("none, and a call that fails, both leave the chat as everyone and still say what happened", async () => {
    answer(undefined, `No persona fits this message.`);
    const chat = chatWith();
    await route(chat).beforeSend(`what is a closure exactly?`);
    expect(chat.actsAs.value).toBeUndefined();
    expect(verdict()).toBe(`No persona matched, so this chat acts as everyone. No persona fits this message. Read by ${ROUTER_LABEL}.`);

    sandboxJson.mockRejectedValueOnce(new Error(`502`));
    const failed = chatWith();
    await route(failed).beforeSend(`please fix the login flow`);
    expect(failed.actsAs.value).toBeUndefined();
    expect(verdict()).toContain(`Couldn't read which persona`);
});

test("nothing is asked when routing is off, no personas exist, the chat has turns, one is pinned, it is elsewhere, or the message is a word", async () => {
    const text = `please fix the login flow`;
    expect(route(chatWith({ messages: ref([{ role: `user` }]) })).beforeSend(text)).toBeUndefined();
    expect(route(chatWith({ actsAs: ref(`social`) })).beforeSend(text)).toBeUndefined();
    expect(route(chatWith({ box: ref(`other-sandbox`) })).beforeSend(text)).toBeUndefined();
    expect(route(chatWith()).beforeSend(`fix it`)).toBeUndefined();

    settings.value = { ...settings.value, personaRouting: false };
    expect(route(chatWith()).beforeSend(text)).toBeUndefined();
    settings.value = { ...settings.value, personaRouting: true };
    personas.value = [];
    expect(route(chatWith()).beforeSend(text)).toBeUndefined();
    personas.value = [{ id: `backend`, label: `Backend`, capabilities: [], models: [{ provider: `claude`, model: `claude-opus-5`, effort: `max` }] }, { id: `social`, capabilities: [] }];

    expect(sandboxJson).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
});

test("a pick by hand overrules routing for good, and one chat buys one reading", async () => {
    const chat = chatWith();
    const routing = route(chat);
    routing.byHand();
    expect(routing.beforeSend(`please fix the login flow`)).toBeUndefined();

    // A chat that matched nothing keeps no card, and still never buys a second reading.
    const other = route(chatWith());
    answer(undefined, `No persona fits this message.`);
    await other.beforeSend(`what is a closure exactly?`);
    expect(sandboxJson).toHaveBeenCalledTimes(1);
    expect(other.beforeSend(`and what is a generator?`)).toBeUndefined();
    expect(sandboxJson).toHaveBeenCalledTimes(1);
});

test("a reading that never lands does not hold the send past the wait", async () => {
    const chat = chatWith();
    sandboxJson.mockReturnValueOnce(new Promise(() => {}));
    let settled = false;
    void route(chat)
        .beforeSend(`please fix the login flow`)
        ?.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(SEND_WAIT_MS + 1);
    expect(settled).toBe(true);
    expect(chat.actsAs.value).toBeUndefined();
    expect(personaRouteWait(chat)).toBeUndefined();
    expect(verdict()).toContain(`Couldn't read which persona`);
});
