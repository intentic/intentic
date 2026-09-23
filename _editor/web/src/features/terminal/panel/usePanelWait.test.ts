import "@intentic/testing/dom";
import { type EffectScope, effectScope, nextTick, ref } from "vue";
import { usePanelWait } from "./usePanelWait";

// Pins the empty panel's wait: it holds itself empty for six seconds on a session on its way and then says what it is
// still waiting for, names a refused list as the asking that failed, and a request it is handed is taken and spent.

const scopes: EffectScope[] = [];

const stage = (initial?: { name: string; title?: string }) => {
    const tabs = {
        pending: ref<string | undefined>(undefined),
        answer: ref<`waiting` | `arrived` | `refused`>(`arrived`),
        focus: jest.fn(async (_name: string) => undefined),
    };
    const scope = effectScope();
    scopes.push(scope);
    const wait = scope.run(() => usePanelWait({ tabs, initial }))!;
    return { tabs, wait };
};

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    jest.useRealTimers();
});

describe(`the empty panel`, () => {
    it(`holds itself empty for six seconds on a session on its way, then says what it still waits for`, async () => {
        const { tabs, wait } = stage();
        tabs.pending.value = `push-web`;
        await nextTick();
        jest.advanceTimersByTime(5_999);
        expect(wait.waited.value).toBe(false);
        jest.advanceTimersByTime(1);
        expect({ waited: wait.waited.value, named: wait.named.value }).toEqual({ waited: true, named: `push-web` });
        expect(wait.emptyHint.value).toBe(
            `It hasn't appeared yet: the sandbox is probably still starting it. This panel keeps looking and shows it the moment it's listed.`,
        );
    });

    it(`names a refused list as the asking that failed`, () => {
        const { tabs, wait } = stage();
        tabs.answer.value = `refused`;
        expect(wait.emptyHint.value).toBe(
            `This sandbox didn't answer when asked what it was running. Anything already going is still going: try again from the refresh button.`,
        );
    });

    it(`tells a panel opened for nothing from one opened for a session that is not there`, () => {
        expect(stage().wait.emptyHint.value).toBe(`Open one to run something here.`);
        const asked = stage({ name: `dev-server` });
        expect({ named: asked.wait.named.value, hint: asked.wait.emptyHint.value }).toEqual({
            named: `dev-server`,
            hint: `Nothing in this sandbox runs under that name, it was started outside it, or it has already stopped.`,
        });
    });

    it(`takes a request it is handed and focuses its session`, async () => {
        const { tabs, wait } = stage();
        await wait.openRequested({ name: `push-web`, title: `Pushing web` });
        expect({ about: wait.about.value, focused: tabs.focus.mock.calls }).toEqual({
            about: { name: `push-web`, title: `Pushing web` },
            focused: [[`push-web`]],
        });
    });
});
