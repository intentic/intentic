// The mirror behind the composer marks exactly the `@path` tokens a send carries as files, and nothing else.
import "@intentic/testing/dom";
import { type App, createApp, h } from "vue";
import ComposerMentionMarks from "./ComposerMentionMarks.vue";

let app: App | undefined;

const mount = (text: string): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    const input = document.createElement(`textarea`);
    app = createApp({ render: () => h(ComposerMentionMarks, { text, input }) });
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`marks each sent mention where it stands, leaving its trailing punctuation and prose handles plain`, () => {
    const element = mount(`In @integra/bench/OPTIMIZATIONS.md, thanks @radarsu`);
    expect([...element.querySelectorAll(`mark`)].map((mark) => mark.textContent)).toEqual([`@integra/bench/OPTIMIZATIONS.md`]);
    expect(element.textContent).toBe(`In @integra/bench/OPTIMIZATIONS.md, thanks @radarsu `);
});

it(`draws no mirror for a draft with nothing to mark`, () => {
    expect(mount(`thanks @radarsu`).firstElementChild).toBeNull();
});
