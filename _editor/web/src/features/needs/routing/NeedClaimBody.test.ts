// A project an agent asks to claim for this sandbox: only the owner's own platform sign-in writes the claim, so the
// owner's press asks the platform first and only then answers the need; anyone else is told whom it waits on.
import "@intentic/testing/dom";
import type { ClaimNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

const calls: string[] = [];
const answer = {
    mutateAsync: jest.fn(async (_input: { id: string; answer: { kind: string } }): Promise<void> => {
        calls.push(`answer`);
    }),
};
const claim = jest.fn(async (_input: { sandboxId: string; project: string }): Promise<{ claims: [] }> => {
    calls.push(`claim`);
    return { claims: [] };
});
const active = ref<{ id: string; tier: string } | undefined>({ id: `sbx-1`, tier: `owner` });
jest.mock(`../../../models/needs/useNeeds`, () => ({ useNeeds: () => ({ answer }) }));
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ active }) }));
jest.mock(`../../../lib/useApi`, () => ({ apiClient: { projects: { claim } } }));
// The need's answer runs its task, as the operations ledger would.
jest.mock(`../needAnswer`, () => ({
    useNeedAnswer: () => ({
        busy: ref(false),
        notice: ref(undefined),
        answer: async (options: { task: () => Promise<void> }): Promise<{ state: `done` }> => {
            await options.task();
            return { state: `done` };
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

const { default: NeedClaimBody } = await import("./NeedClaimBody.vue");

const SUBJECT: ClaimNeed = { kind: `claim`, project: `github.com/acme/app` };
const NEED: Need = { id: `need-9`, conversationId: `c-1`, title: `Claim github.com/acme/app for this sandbox`, subject: SUBJECT, status: `open`, createdAt: 1, updatedAt: 1 };

const mount = (subject: ClaimNeed = SUBJECT) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(NeedClaimBody, { need: { ...NEED, subject }, subject }) });
    app.mount(el);
    return {
        el,
        done: (): void => {
            app.unmount();
            el.remove();
        },
    };
};

beforeEach(() => {
    calls.length = 0;
    answer.mutateAsync.mockClear();
    claim.mockClear();
    active.value = { id: `sbx-1`, tier: `owner` };
});

it("claims the project on the platform for this sandbox, then answers the need, on the owner's one press", async () => {
    const { el, done } = mount();
    expect(el.textContent).toContain(`github.com/acme/app`);
    const press = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Claim for this sandbox`);
    press?.click();
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
    expect(claim).toHaveBeenCalledWith({ sandboxId: `sbx-1`, project: `github.com/acme/app` });
    expect(answer.mutateAsync).toHaveBeenCalledWith({ id: `need-9`, answer: { kind: `approve` } });
    expect(calls).toEqual([`claim`, `answer`]);
    done();
});

it("says which sandbox it moves from", () => {
    const { el, done } = mount({ ...SUBJECT, heldBy: `billing` });
    expect(el.querySelector(`[data-claim-moves]`)?.textContent).toContain(`billing`);
    done();
});

it("offers no press to anyone but the owner, and says whom it waits on", () => {
    active.value = { id: `sbx-1`, tier: `maintainer` };
    const { el, done } = mount();
    expect([...el.querySelectorAll(`button`)].some((button) => button.textContent?.trim() === `Claim for this sandbox`)).toBe(false);
    expect(el.querySelector(`[data-claim-waits]`)?.textContent).toContain(`owner`);
    done();
});
