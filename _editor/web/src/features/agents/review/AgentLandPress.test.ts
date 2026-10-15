// The review's one press: in plain words it comes with one sentence saying what accepting does, and a developer's press
// is the press alone, as it always was.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { useAudience } from "../../../app/useAudience";
import AgentLandPress from "./AgentLandPress.vue";

let app: App | undefined;
const { audience } = useAudience();

const mount = async (props: { canShip: boolean; fix?: { count: number; state: `ready`; busy: boolean } }): Promise<HTMLElement> => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () => h(AgentLandPress, { requested: false, landDisabled: false, requesting: false, landHint: { title: `` }, requestHint: { title: `` }, ...props }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    await nextTick();
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    audience.value = `developer`;
});

const SENTENCE = `Accept puts the assistant’s files into your folders; until then they stay in this conversation’s draft.`;

describe(`AgentLandPress`, () => {
    it(`says above Accept, in plain words, what accepting does`, async () => {
        audience.value = `maker`;
        const element = await mount({ canShip: true });
        expect(element.querySelector(`p`)?.textContent).toBe(SENTENCE);
        expect(element.querySelector(`button`)?.textContent).toContain(`Accept`);
    });

    it(`leaves a developer's press without the sentence`, async () => {
        const element = await mount({ canShip: true });
        expect(element.querySelector(`p`)).toBeNull();
        expect(element.querySelectorAll(`button`)).toHaveLength(1);
    });

    it(`says nothing over a press that is not Accept: a request, or the fix for a refused land`, async () => {
        audience.value = `maker`;
        expect((await mount({ canShip: false })).querySelector(`p`)).toBeNull();
        app?.unmount();
        expect((await mount({ canShip: true, fix: { count: 1, state: `ready`, busy: false } })).querySelector(`p`)).toBeNull();
    });
});
