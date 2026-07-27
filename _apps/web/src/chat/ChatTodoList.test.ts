// @vitest-environment jsdom
//
// jsdom because what this component decides is what it RENDERS: a checklist in the transcript is a snapshot,
// so which row animates (and how the row that was underway reads once nothing is moving it) is the whole
// component. Only a mounted render can answer that.
import { afterEach, describe, expect, it } from "vitest";
import type { TodoItem } from "@intentic/sandbox-contract";
import { type App, createApp, defineComponent, h } from "vue";
import ChatTodoList from "./ChatTodoList.vue";

const LIST: TodoItem[] = [
    { content: `Serialize git write routes`, status: `in_progress`, activeForm: `Serializing git write routes` },
    { content: `Typecheck, lint and test`, status: `pending` },
    { content: `Add the per-repo lock`, status: `completed` },
];

let app: App | undefined;
const mount = (todos: TodoItem[], live: boolean): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatTodoList, { todos, live }) });
    // Icon is registered app-wide in the real app. The stand-in renders which glyph it was handed (and whether
    // it spins), because that IS what this component decides.
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name, class: this.spin ? `animate-spin` : undefined });
            },
        }),
    );
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`ChatTodoList`, () => {
    it(`spins the active row while the bubble is still streaming, in its present-tense form`, () => {
        const element = mount(LIST, true);
        expect(element.querySelector(`.animate-spin`)).not.toBeNull();
        expect(element.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
        expect(element.textContent).toContain(`Serializing git write routes`);
    });

    it(`freezes the active row once the bubble is settled — a snapshot must not animate`, () => {
        // The reported bug: scrolling back through a session that finished long ago and finding a row still
        // spinning, which reads as an agent still working.
        const element = mount(LIST, false);
        expect(element.querySelector(`.animate-spin`)).toBeNull();
        expect(element.querySelector(`[data-icon="spinner"]`)).toBeNull();
        // Still marked as the row the agent had reached — a filled dot where the spinner was.
        expect(element.querySelector(`[data-icon="circle-fill"]`)).not.toBeNull();
        // And read back in the same imperative form as the rows around it, not as something in progress.
        expect(element.textContent).toContain(`Serialize git write routes`);
        expect(element.textContent).not.toContain(`Serializing`);
    });

    it(`leaves settled rows alone either way`, () => {
        for (const live of [true, false]) {
            const element = mount(LIST, live);
            expect(element.querySelector(`[data-icon="check-circle"]`)).not.toBeNull();
            expect(element.querySelector(`[data-icon="circle"]`)).not.toBeNull();
            app?.unmount();
            app = undefined;
        }
    });
});
