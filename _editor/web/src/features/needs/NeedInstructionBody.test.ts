// A rule the agent proposes keeping in an AGENTS.md: the card shows the exact change the daemon drew, says where it
// goes, and its one press is the approval that writes it. Nothing is written by drawing it.
import "@intentic/testing/dom";
import type { InstructionNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

const answer = { mutateAsync: jest.fn(async (_input: { id: string; answer: { kind: string } }): Promise<void> => undefined) };
jest.mock(`../../models/needs/useNeeds`, () => ({ useNeeds: () => ({ answer }) }));
// The need's answer runs its task, as the operations ledger would.
jest.mock(`./needAnswer`, () => ({
    useNeedAnswer: () => ({
        busy: ref(false),
        notice: ref(undefined),
        answer: async (options: { task: () => Promise<void> }): Promise<{ state: `done` }> => {
            await options.task();
            return { state: `done` };
        },
    }),
}));
// The diff as text: highlighting is the code view's own suite.
jest.mock(`@intentic/ui`, () => ({
    Code: defineComponent({ props: { code: { type: String, required: true }, lang: String }, setup: (props) => () => h(`pre`, { "data-lang": props.lang }, props.code) }),
    Notice: defineComponent({ setup: () => () => h(`div`) }),
}));
jest.mock(`../../components/ChatDecisionButton.vue`, () => ({
    default: defineComponent({
        props: { disabled: Boolean },
        emits: [`click`],
        setup: (props, { slots, emit }) => () => h(`button`, { type: `button`, disabled: props.disabled, onClick: () => emit(`click`) }, slots[`default`]?.()),
    }),
}));

const { default: NeedInstructionBody } = await import("./NeedInstructionBody.vue");

const DIFF = `--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,2 @@\n - Port Bevy's algorithm when ours loses.\n+- Don't overdo tests.`;
const SUBJECT: InstructionNeed = { kind: `instruction`, file: `AGENTS.md`, text: `- Don't overdo tests.`, diff: DIFF };
const NEED: Need = { id: `need-7`, conversationId: `c-1`, title: `Remember in AGENTS.md: Don't overdo tests.`, subject: SUBJECT, status: `open`, createdAt: 1, updatedAt: 1 };

const mount = (subject: InstructionNeed = SUBJECT) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(NeedInstructionBody, { need: { ...NEED, subject }, subject }) });
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
    answer.mutateAsync.mockClear();
});

it("shows the exact change as a diff and approves it with one press, writing nothing before", async () => {
    const { el, done } = mount();
    expect(el.querySelector(`pre[data-lang="diff"]`)?.textContent).toBe(DIFF);
    expect(el.textContent).toContain(`Every conversation that starts there follows it from its next turn.`);
    expect(answer.mutateAsync).not.toHaveBeenCalled();
    const add = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Add to AGENTS.md`);
    add?.click();
    await nextTick();
    await Promise.resolve();
    expect(answer.mutateAsync).toHaveBeenCalledWith({ id: `need-7`, answer: { kind: `approve` } });
    done();
});

it("says so when approving creates the file", () => {
    const { el, done } = mount({ ...SUBJECT, file: `game/AGENTS.md`, creates: true });
    expect(el.textContent).toContain(`game/AGENTS.md does not exist yet: approving creates it with this rule.`);
    done();
});
