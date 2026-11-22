// The computer a sandbox runs on would sleep through work booked on it: the card says when that work is due, each setting
// as it reads now and as approving leaves it, and what nothing here changes as notes. Its one press runs the agent's
// `power-stay-on` on that computer; drawing it changes nothing.
import "@intentic/testing/dom";
import type { HostPowerFinding } from "@intentic/sandbox-contract/schemas/host-power";
import type { HostPowerNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import { formatWhen } from "@intentic/ui/format";
import { IconStub } from "@intentic/ui/testing";
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
// A command as text: highlighting is the code view's own suite.
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

const { default: NeedHostPowerBody } = await import("./NeedHostPowerBody.vue");

// rog the night it slept: a plan that sleeps it five hours after the last keypress, a lid that does, standby that cuts
// the network, and the two things the op leaves as they are.
const LID: HostPowerFinding = { id: `lid-close`, power: `ac`, action: `sleep`, fixable: true, text: `Closing the lid sleeps it.` };
const SLEEPS: HostPowerFinding = { id: `sleep-idle`, power: `ac`, afterSeconds: 5 * 3600, fixable: true, text: `Sleeps after 5 hours.` };
const STANDBY: HostPowerFinding = { id: `standby-network`, fixable: true, text: `Modern Standby cuts the network.` };
const BATTERY: HostPowerFinding = { id: `battery-sleep`, power: `dc`, afterSeconds: 900, fixable: false, text: `On battery it sleeps after 15 minutes.` };
const UPDATE: HostPowerFinding = { id: `update-restart`, window: { fromHour: 2, toHour: 8 }, fixable: false, text: `Windows Update may restart it.` };
const DUE = Date.UTC(2026, 10, 23, 6, 10);
const SUBJECT: HostPowerNeed = { kind: `host-power`, device: `rog`, findings: [LID, SLEEPS, STANDBY, BATTERY, UPDATE], dueAt: DUE };
const NEED: Need = { id: `need-4`, conversationId: `c-1`, title: `rog would sleep through your send`, subject: SUBJECT, status: `open`, createdAt: 1, updatedAt: 1 };

const mount = (subject: HostPowerNeed = SUBJECT, status: Need[`status`] = `open`) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({
        render: () => h(NeedHostPowerBody, { need: { ...NEED, subject, status }, subject }, { decline: () => h(`button`, { type: `button` }, `Not now`) }),
    });
    app.component(`Icon`, IconStub);
    app.mount(el);
    return {
        el,
        changes: (): string[][] =>
            [...el.querySelectorAll(`[data-power-change]`)].map((line) => [...line.querySelectorAll(`span`)].map((part) => part.textContent ?? ``)),
        notes: (): string[] => [...el.querySelectorAll(`[data-power-note]`)].map((note) => note.textContent ?? ``),
        buttons: (): string[] => [...el.querySelectorAll(`button`)].map((button) => button.textContent?.trim() ?? ``),
        done: (): void => {
            app.unmount();
            el.remove();
        },
    };
};

beforeEach(() => {
    answer.mutateAsync.mockClear();
});

it(`says when the booked work is due, then each setting as it is and as approving leaves it, worst first`, () => {
    const { el, changes, done } = mount();
    expect(el.textContent).toContain(`rog would stop the work booked for ${formatWhen(DUE)}.`);
    expect(changes()).toEqual([
        [`Sleeps after 5h without input on mains power`, `never`],
        [`Closing the lid puts it to sleep`, `does nothing`],
        [`Cuts the network in standby`, `keeps it`],
    ]);
    done();
});

// The update window is in rog's own hours, and the card carries no offset to move them by, so it names whose clock.
it(`keeps what the op leaves alone as notes, in the reader's words`, () => {
    const { notes, done } = mount();
    expect(notes()).toEqual([
        `On battery it still sleeps after 15m: keep it plugged in for the night.`,
        `Windows Update may restart it between 02:00 and 08:00 (rog's clock); after a restart nothing runs until you sign in.`,
    ]);
    done();
});

it(`changes the settings with one press, and nothing before it`, async () => {
    const { el, buttons, done } = mount();
    expect(buttons()).toEqual([`Change these settings on rog`, `Not now`]);
    expect(answer.mutateAsync).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>(`button`)?.click();
    await nextTick();
    await Promise.resolve();
    expect(answer.mutateAsync).toHaveBeenCalledWith({ id: `need-4`, answer: { kind: `approve` } });
    done();
});

// A Linux laptop: nothing the op changes, only a command to run there by hand. A yes would do nothing, so there is none.
it(`offers only "Not now" on a card of notes, with the command to run by hand shown whole`, () => {
    const command = `sudo systemctl mask sleep.target suspend.target`;
    const suspend: HostPowerFinding = { id: `os-sleep`, fixable: false, command, text: `The OS may suspend it.` };
    const { el, notes, buttons, done } = mount({ kind: `host-power`, device: `z440`, findings: [suspend] });
    expect(notes()).toEqual([`It may suspend itself. To stop that, run this on z440:`]);
    expect(el.querySelector(`pre[data-lang="bash"]`)?.textContent).toBe(command);
    expect(buttons()).toEqual([`Not now`]);
    expect(el.textContent).toContain(`z440 would stop the work booked on it.`);
    done();
});

// A newer agent's finding: its own sentence stands in for words this build does not have.
it(`says a finding it has no words for in the agent's own sentence`, () => {
    const hybrid: HostPowerFinding = { id: `hybrid-sleep`, fixable: true, text: `Hybrid sleep is on.` };
    const { changes, done } = mount({ ...SUBJECT, findings: [hybrid] });
    expect(changes()).toEqual([[`Hybrid sleep is on`]]);
    done();
});

// Approved and being carried out: the card's header says so (needStatus.ts), and nothing here can be pressed again.
it(`draws no answers once the yes is being carried out`, () => {
    const { buttons, done } = mount(SUBJECT, `working`);
    expect(buttons()).toEqual([]);
    done();
});
