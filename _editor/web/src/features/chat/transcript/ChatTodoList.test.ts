// @vitest-environment jsdom
// Needs jsdom: whether a row animates is what this component renders, and only a mounted render can show that.
import { afterEach, describe, expect, it } from "vitest";
import type { TodoItem } from "@intentic/sandbox-contract";
import { type App, createApp, h } from "vue";
import ChatTodoList from "./ChatTodoList.vue";
import { IconStub } from "@intentic/ui/testing";

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
    // Icon stub renders which glyph and spin state it was handed, since that is what this component decides.
    app.component(`Icon`, IconStub);
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
        expect(element.querySelector(`[data-spin]`)).not.toBeNull();
        expect(element.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
        expect(element.textContent).toContain(`Serializing git write routes`);
    });

    it(`freezes the active row once the bubble is settled: a snapshot must not animate`, () => {
        const element = mount(LIST, false);
        expect(element.querySelector(`[data-spin]`)).toBeNull();
        expect(element.querySelector(`[data-icon="spinner"]`)).toBeNull();
        expect(element.querySelector(`[data-icon="circle-fill"]`)).not.toBeNull();
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
