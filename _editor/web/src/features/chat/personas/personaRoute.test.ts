import type { SandboxSettings } from "@intentic/api-contract";
import { SandboxSettingsSchema } from "@intentic/api-contract";
import type { Persona } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { effectScope, type EffectScope, ref } from "vue";

// Pins the composer's half of persona routing: what a mocked daemon answer becomes on screen, and what a send does with
// it. Gates, modes, and one-reading-per-text are what this tests, not the daemon's own reading.

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

const { SEND_WAIT_MS, SETTLE_MS, usePersonaRoute } = await import("./personaRoute");
type Chat = Parameters<typeof usePersonaRoute>[0] extends () => infer C ? C : never;

// Only the fields routing reads and writes; a real Conversation drags a transcript and stream along.
const wearModel = vi.fn();
const chatWith = (over: Record<string, unknown> = {}): Chat =>
    ({
        box: ref(undefined),
        messages: ref([]),
        actsAs: ref(undefined),
        attachments: ref([]),
        wearModel,
        ...over,
    }) as unknown as Chat;

const answer = (persona: string | undefined, reason = `because`) => sandboxJson.mockResolvedValueOnce({ ...(persona === undefined ? {} : { persona }), reason });
const sent = (call = 0): { prompt: string; paths: string[] } => JSON.parse(String(sandboxJson.mock.calls[call]?.[1]?.body)) as { prompt: string; paths: string[] };

const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
};

// Each test's composables run in a scope stopped afterward, as a pane's would be on unmount; a watcher left running
// could otherwise fire on the next test's settings change.
let scope: EffectScope;
const route = (chat: Chat, draft: () => string): ReturnType<typeof usePersonaRoute> => scope.run(() => usePersonaRoute(() => chat, draft))!;

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
});

test("suggest is the default: a settled draft is read once, and the answer is offered, not applied", async () => {
    expect(settings.value.personaRouting).toBe(`suggest`);
    const chat = chatWith({ attachments: ref([{ path: `docs/spec.md` }]) });
    const draft = ref(`the invoice totals are off in @api/src/totals.ts`);
    answer(`backend`, `The message reads like Backend's work.`);
    const routing = route(chat, () => draft.value);

    expect(sandboxJson).not.toHaveBeenCalled();
    await settle();
    expect(sandboxJson).toHaveBeenCalledTimes(1);
    expect(sandboxJson.mock.calls[0]?.[0]).toBe(`/personas/route`);
    expect(sent()).toEqual({ prompt: `the invoice totals are off in @api/src/totals.ts`, paths: [`docs/spec.md`, `api/src/totals.ts`] });

    expect(routing.preview.value).toMatchObject({ kind: `suggest`, persona: { id: `backend` }, reason: `The message reads like Backend's work.` });
    expect(chat.actsAs.value).toBeUndefined();
    expect(routing.beforeSend(draft.value)).toBeUndefined();

    routing.press();
    expect(chat.actsAs.value).toBe(`backend`);
    expect(wearModel).toHaveBeenCalledWith({ provider: `claude`, model: `claude-opus-5`, effort: `max` });
    expect(routing.preview.value).toBeUndefined();
});

test("the same words are never read twice, and new words are read again after they settle", async () => {
    const chat = chatWith();
    const draft = ref(`please fix the login flow`);
    answer(`backend`);
    const routing = route(chat, () => draft.value);
    await settle();
    expect(sandboxJson).toHaveBeenCalledTimes(1);
    // Trailing whitespace counts as the same message.
    draft.value = `please fix the login flow   `;
    await settle();
    expect(sandboxJson).toHaveBeenCalledTimes(1);
    draft.value = `please fix the login flow, and post about it`;
    answer(`social`);
    expect(routing.preview.value).toMatchObject({ persona: { id: `backend` } });
    await settle();
    expect(sandboxJson).toHaveBeenCalledTimes(2);
    expect(sent(1).prompt).toBe(`please fix the login flow, and post about it`);
    expect(routing.preview.value).toMatchObject({ persona: { id: `social` } });
});

test("nothing is asked when routing is off, the chat has turns, a persona is pinned, the chat is elsewhere, or the draft is a word", async () => {
    const draft = ref(`please fix the login flow`);
    const cases: Chat[] = [
        chatWith({ messages: ref([{ role: `user` }]) }),
        chatWith({ actsAs: ref(`social`) }),
        chatWith({ box: ref(`other-sandbox`) }),
    ];
    for (const chat of cases) {
        route(chat, () => draft.value);
    }
    route(chatWith(), () => `fix it`);
    settings.value = { ...settings.value, personaRouting: `off` };
    route(chatWith(), () => draft.value);
    await settle();
    expect(sandboxJson).not.toHaveBeenCalled();
});

test("none, and a call that fails, both leave the composer alone", async () => {
    const chat = chatWith();
    answer(undefined, `No persona fits this message.`);
    const routing = route(chat, () => `what is a closure exactly?`);
    await settle();
    expect(routing.preview.value).toBeUndefined();
    sandboxJson.mockRejectedValueOnce(new Error(`502`));
    const failing = route(chatWith(), () => `please fix the login flow`);
    await settle();
    expect(failing.preview.value).toBeUndefined();
    expect(failing.beforeSend(`please fix the login flow`)).toBeUndefined();
});

test("auto shows the card that will go on, the press declines it, and a pick by hand overrules it for good", async () => {
    settings.value = { ...settings.value, personaRouting: `auto` };
    const chat = chatWith();
    answer(`backend`);
    const routing = route(chat, () => `please fix the login flow`);
    await settle();
    expect(routing.preview.value).toMatchObject({ kind: `route`, persona: { id: `backend` } });

    routing.press();
    expect(routing.preview.value).toMatchObject({ kind: `held` });
    expect(routing.beforeSend(`please fix the login flow`)).toBeUndefined();
    routing.press();
    expect(routing.preview.value).toMatchObject({ kind: `route` });

    routing.byHand();
    expect(routing.preview.value).toMatchObject({ kind: `held` });
    expect(routing.beforeSend(`please fix the login flow`)).toBeUndefined();
});

test("auto applies the reading at send, waiting briefly for one still in flight", async () => {
    settings.value = { ...settings.value, personaRouting: `auto` };
    const chat = chatWith();
    const routing = route(chat, () => `please fix the login flow`);
    // Sent immediately, before the draft settles, so beforeSend does the asking itself.
    let resolve!: (value: unknown) => void;
    sandboxJson.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const wait = routing.beforeSend(`please fix the login flow`);
    expect(wait).toBeInstanceOf(Promise);
    expect(sandboxJson).toHaveBeenCalledTimes(1);
    let settled = false;
    void wait!.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(SEND_WAIT_MS / 2);
    expect(settled).toBe(false);
    resolve({ persona: `backend`, reason: `because` });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(chat.actsAs.value).toBe(`backend`);
    expect(wearModel).toHaveBeenCalledTimes(1);
});

test("auto does not hold a send past the wait: a reading that never lands is no reading", async () => {
    settings.value = { ...settings.value, personaRouting: `auto` };
    const chat = chatWith();
    sandboxJson.mockReturnValueOnce(new Promise(() => {}));
    const routing = route(chat, () => `please fix the login flow`);
    let settled = false;
    void routing.beforeSend(`please fix the login flow`)?.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(SEND_WAIT_MS + 1);
    expect(settled).toBe(true);
    expect(chat.actsAs.value).toBeUndefined();
});
