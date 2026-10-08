// The privacy shield's strip above the composer. First reported case (2026-10-02): a Cursor conversation sent twice into
// a refusal that read like a finding, and the only way through was trusting Cursor in every conversation; the strip
// said it before the send, and its press let Cursor read this one conversation, then sent what the refusal held.
// Second (2026-10-08): that warning stood over every Cursor chat before a word was written. The shield reads Cursor by
// content now, so for Cursor the strip speaks only once a turn was refused for what it found; before the send it speaks
// only for an agent the shield can't read at all.
import "@intentic/testing/dom";
import {
    ACP,
    CLAUDE_CODE,
    CURSOR,
    DEFAULT_PRIVACY_SHIELD,
    type AgentCapabilities,
    type PrivacyShieldPolicy,
    type PrivacyShieldStatus,
} from "@intentic/sandbox-contract";
import { type App, createApp, h, nextTick, ref, shallowRef } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as vueRouterOriginal from "vue-router";
import { RouterLinkStub } from "../../../../testing/routerLinkStub";

const provider = ref(`my-acp`);
const capabilities = ref<AgentCapabilities>(ACP);
const queuePaused = ref<string | undefined>(undefined);
const lastFailure = ref<{ code: string; text?: string } | undefined>(undefined);
const resumeQueue = jest.fn(async () => {});
const streaming = ref(false);
jest.mock(`../useChat-view`, () => ({
    usePaneView: () => ({
        conversation: shallowRef({ conversationId: `vivid-rowan-moks` }),
        provider,
        capabilities,
        queuePaused,
        lastFailure,
        resumeQueue,
        streaming,
    }),
}));
const reachable = ref(true);
const active = ref<{ role: string } | undefined>({ role: `owner` });
jest.mock(`../../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable, active }) }));

const policy = ref<PrivacyShieldPolicy>({ ...DEFAULT_PRIVACY_SHIELD, mode: `on` });
const status = ref<PrivacyShieldStatus | undefined>(undefined);
// What the press asked the daemon to hold, in the order it asked; a refusal is set per test.
const written: PrivacyShieldPolicy[] = [];
let refuse = false;
const updatePolicy = jest.fn(async (change: (current: PrivacyShieldPolicy) => PrivacyShieldPolicy) => {
    if (refuse) {
        throw new Error(`403`);
    }
    policy.value = change(policy.value);
    written.push(policy.value);
    status.value = statusOf(policy.value);
});
jest.mock(`../../../sandbox/agent-settings/safety/usePrivacyShield`, () => ({
    usePrivacyShield: () => ({ status, updatePolicy, isSaving: ref(false) }),
}));
// SAFETY: the stub renders the one prop the strip passes (`to`), which is all a RouterLink is asked for here.
jest.mock(`vue-router`, () => ({ ...vueRouterOriginal, RouterLink: RouterLinkStub as never }));

const statusOf = (current: PrivacyShieldPolicy): PrivacyShieldStatus => ({
    policy: current,
    known: 0,
    tokens: 0,
    readers: { ocr: false, model: false },
    providers: [
        { id: `cursor`, label: `Cursor`, shieldable: true, local: false },
        { id: `my-acp`, label: `My agent`, shieldable: false, local: false },
    ],
});

const { default: ChatPrivacyStrip } = await import("./ChatPrivacyStrip.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatPrivacyStrip) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const named = (element: HTMLElement, label: string): HTMLElement | undefined =>
    [...element.querySelectorAll(`button, a`)].find((control): control is HTMLElement => control.textContent?.includes(label) === true);

const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) {
        await nextTick();
    }
};

beforeEach(() => {
    provider.value = `my-acp`;
    capabilities.value = ACP;
    queuePaused.value = undefined;
    lastFailure.value = undefined;
    streaming.value = false;
    reachable.value = true;
    active.value = { role: `owner` };
    policy.value = { ...DEFAULT_PRIVACY_SHIELD, mode: `on` };
    status.value = statusOf(policy.value);
    written.length = 0;
    refuse = false;
    resumeQueue.mockClear();
    updatePolicy.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The reported case: opening a Cursor chat while the shield masks says nothing, since nothing has been found.
it(`says nothing over a Cursor chat before anything was found`, () => {
    provider.value = `cursor`;
    capabilities.value = CURSOR;
    const element = mount();
    expect(element.textContent?.trim()).toBe(``);
});

it(`says what the shield found once a Cursor turn was refused for it, and lets Cursor read this conversation`, async () => {
    provider.value = `cursor`;
    capabilities.value = CURSOR;
    queuePaused.value = `refused`;
    const reason = `The privacy shield did not send this to Cursor: AGENTS.md holds personal data (names).`;
    lastFailure.value = { code: `privacy-instructions`, text: reason };
    const element = mount();
    expect(element.textContent).toContain(reason);
    named(element, `Let Cursor read this conversation`)?.click();
    await settle();
    expect(written.at(-1)?.conversations).toEqual([{ conversationId: `vivid-rowan-moks`, provider: `cursor` }]);
    expect(resumeQueue).toHaveBeenCalledTimes(1);
    expect(element.textContent).toContain(`Cursor reads this conversation as it is`);
});

it(`says before the send that an agent the shield can't read would be turned away, and that nothing written is why`, () => {
    const element = mount();
    expect(element.textContent).toContain(`won't send this to My agent, and nothing you wrote is the reason`);
    expect(named(element, `Let My agent read this conversation`)?.tagName).toBe(`BUTTON`);
    expect(named(element, `Safety settings`)?.tagName).toBe(`A`);
});

it(`lets the agent read this conversation alone, and sends the message the refusal held`, async () => {
    queuePaused.value = `refused`;
    lastFailure.value = { code: `privacy-unshielded` };
    const element = mount();
    named(element, `Let My agent read this conversation`)?.click();
    await settle();
    expect(written.at(-1)?.conversations).toEqual([{ conversationId: `vivid-rowan-moks`, provider: `my-acp` }]);
    // Never the everywhere switch: that stays the owner's choice on the Safety page.
    expect(written.at(-1)?.trusted).toEqual([]);
    expect(resumeQueue).toHaveBeenCalledTimes(1);
    expect(element.textContent).toContain(`My agent reads this conversation as it is`);
});

it(`sends nothing when the queue is held for another reason`, async () => {
    queuePaused.value = `refused`;
    lastFailure.value = { code: `sandbox-memory-low` };
    const element = mount();
    named(element, `Let My agent read this conversation`)?.click();
    await settle();
    expect(written).toHaveLength(1);
    expect(resumeQueue).not.toHaveBeenCalled();
});

it(`takes the grant back from the quiet line it leaves`, async () => {
    policy.value = { ...policy.value, conversations: [{ conversationId: `vivid-rowan-moks`, provider: `my-acp` }] };
    status.value = statusOf(policy.value);
    const element = mount();
    named(element, `Take back`)?.click();
    await settle();
    expect(written.at(-1)?.conversations).toEqual([]);
    expect(element.textContent).toContain(`won't send this to My agent`);
});

it(`a member is told only the owner can let it through, and offered no press that would be refused`, () => {
    active.value = { role: `member` };
    const element = mount();
    expect(element.textContent).toContain(`Only the sandbox's owner can let it through.`);
    expect(named(element, `Let My agent read this conversation`)).toBeUndefined();
});

it(`says a refused grant beside the press, and sends nothing`, async () => {
    refuse = true;
    queuePaused.value = `refused`;
    lastFailure.value = { code: `privacy-unshielded` };
    const element = mount();
    named(element, `Let My agent read this conversation`)?.click();
    await settle();
    expect(element.textContent).toContain(`That didn't save.`);
    expect(resumeQueue).not.toHaveBeenCalled();
});

it(`is not drawn for a runtime the gateway masks`, () => {
    provider.value = `claude`;
    capabilities.value = CLAUDE_CODE;
    const element = mount();
    expect(element.textContent?.trim()).toBe(``);
});
