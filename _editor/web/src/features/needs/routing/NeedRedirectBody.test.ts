// A person's message offered on to the sandbox it was meant for: the card shows their words whole, only they can press
// it, and the press records the answer before it opens a chat in the target with those words, so a refused press sends
// nothing. Anyone else reads whom it waits on.
import "@intentic/testing/dom";
import type { Need, RedirectNeed } from "@intentic/sandbox-contract/schemas/needs";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

const calls: string[] = [];
const answer = {
    mutateAsync: jest.fn(async (_input: { id: string; answer: { kind: string } }): Promise<void> => {
        calls.push(`answer`);
    }),
};
const startAgent = jest.fn((_prompt: string, _actsAs: unknown, _run: unknown, _opening: { box?: string }): string => {
    calls.push(`start`);
    return `c-new`;
});
const user = ref<{ email: string } | null>({ email: `Ada@Acme.test` });
const sandboxes = ref([
    { id: `sbx-here`, name: `app`, daemonUrl: `https://sandbox-aaaaaaaaaaaa.sbx.test` },
    { id: `sbx-ops`, name: `ops`, daemonUrl: `https://sandbox-bbbbbbbbbbbb.sbx.test` },
]);
jest.mock(`../../../models/needs/useNeeds`, () => ({ useNeeds: () => ({ answer }) }));
jest.mock(`../../../models/fleet/agentActions`, () => ({ startAgent }));
jest.mock(`../../../client/auth/useAuth`, () => ({ useAuth: () => ({ user }) }));
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ sandboxes }) }));
jest.mock(`../needAnswer`, () => ({
    useNeedAnswer: () => ({
        busy: ref(false),
        notice: ref(undefined),
        answer: async (options: { task: () => Promise<void> }): Promise<{ state: `done` | `failed` }> => {
            try {
                await options.task();
                return { state: `done` };
            } catch {
                return { state: `failed` };
            }
        },
    }),
}));
jest.mock(`@intentic/ui`, () => ({ Notice: defineComponent({ setup: () => () => h(`div`) }) }));
jest.mock(`../../../components/ChatDecisionButton.vue`, () => ({
    default: defineComponent({
        props: { disabled: Boolean },
        emits: [`click`],
        setup: (props, { slots, emit }) => () => h(`button`, { type: `button`, disabled: props.disabled, onClick: () => emit(`click`) }, slots[`default`]?.()),
    }),
}));

const { default: NeedRedirectBody } = await import("./NeedRedirectBody.vue");

const WORDS = `fix the login bug in acme/app\nit started after Tuesday's deploy`;
const SUBJECT: RedirectNeed = {
    kind: `redirect`,
    target: `bbbbbbbbbbbb`,
    targetName: `ops`,
    address: `https://sandbox-bbbbbbbbbbbb.sbx.test`,
    person: `ada@acme.test`,
    words: WORDS,
};
const NEED: Need = { id: `need-3`, conversationId: `c-1`, title: `Send this message on to ops`, subject: SUBJECT, status: `open`, createdAt: 1, updatedAt: 1 };

const mount = (subject: RedirectNeed = SUBJECT) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(NeedRedirectBody, { need: { ...NEED, subject }, subject }) });
    app.mount(el);
    return {
        el,
        done: (): void => {
            app.unmount();
            el.remove();
        },
    };
};

const sendButton = (el: HTMLElement) => [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Send to ops`);

const settle = async (): Promise<void> => {
    await nextTick();
    for (let tick = 0; tick < 4; tick += 1) {
        await Promise.resolve();
    }
};

beforeEach(() => {
    calls.length = 0;
    answer.mutateAsync.mockClear();
    startAgent.mockClear();
    user.value = { email: `Ada@Acme.test` };
});

it("shows the words whole, and on the person's press answers the need, then sends the words in a new chat in the target", async () => {
    const { el, done } = mount();
    expect(el.querySelector(`[data-redirect-words]`)?.textContent).toBe(WORDS);
    sendButton(el)?.click();
    await settle();
    expect(answer.mutateAsync).toHaveBeenCalledWith({ id: `need-3`, answer: { kind: `approve` } });
    expect(startAgent).toHaveBeenCalledWith(WORDS, undefined, undefined, { box: `sbx-ops` });
    expect(calls).toEqual([`answer`, `start`]);
    done();
});

it("sends nothing when the daemon refuses the answer", async () => {
    answer.mutateAsync.mockImplementationOnce(async () => {
        throw new Error(`Only ada@acme.test can send their message on.`);
    });
    const { el, done } = mount();
    sendButton(el)?.click();
    await settle();
    expect(startAgent).not.toHaveBeenCalled();
    done();
});

it("says what stays behind: the files that went with it, and the tail of a message too long for the card", () => {
    const { el, done } = mount({ ...SUBJECT, attachments: 2, clipped: true });
    expect(el.querySelector(`[data-redirect-files]`)?.textContent).toContain(`2 files`);
    expect(el.querySelector(`[data-redirect-clipped]`)).not.toBeNull();
    done();
});

it("offers no press to anyone but the person, and says whom it waits on", () => {
    user.value = { email: `owner@acme.test` };
    const { el, done } = mount();
    expect(sendButton(el)).toBeUndefined();
    expect(el.querySelector(`[data-redirect-waits]`)?.textContent).toContain(`ada@acme.test`);
    done();
});

it("says so when the target is not among the reader's sandboxes here", () => {
    const { el, done } = mount({ ...SUBJECT, address: `https://sandbox-cccccccccccc.sbx.test`, targetName: `elsewhere` });
    expect(sendButton(el)).toBeUndefined();
    expect(el.querySelector(`[data-redirect-unreachable]`)?.textContent).toContain(`elsewhere`);
    done();
});
