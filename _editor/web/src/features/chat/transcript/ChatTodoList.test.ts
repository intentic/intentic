// Needs jsdom: whether a row animates is what this component renders, and only a mounted render can show that.
import "@intentic/testing/dom";
import { describe, it, expect, afterEach } from "bun:test";
import type { TodoItem } from "@intentic/sandbox-contract";
import { type App, createApp, h } from "vue";
import ChatTodoList from "./ChatTodoList.vue";
import type { ChecklistView } from "./transcript";
import { IconStub } from "@intentic/ui/testing";

const LIST: TodoItem[] = [
    { content: `Serialize git write routes`, status: `in_progress`, activeForm: `Serializing git write routes` },
    { content: `Typecheck, lint and test`, status: `pending` },
    { content: `Add the per-repo lock`, status: `completed` },
];

let app: App | undefined;
const mount = (todos: TodoItem[], live: boolean, view?: ChecklistView): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatTodoList, { todos, live, view }) });
    // Icon stub renders which glyph and spin state it was handed, since that is what this component decides.
    app.component(`Icon`, IconStub);
    app.mount(element);
    return element;
};

// What the projection hands a snapshot in the middle of its turn: one task done, the next one picked up.
const MOVED: ChecklistView = {
    kind: `delta`,
    finished: [LIST[2]!],
    started: [LIST[0]!],
    parked: [],
    added: 0,
    dropped: 0,
    doneBefore: 0,
    done: 1,
    total: 3,
};

// The move that reads as a completion and is not one: the active row changes while the task it leaves stays open.
const HANDED_OVER: ChecklistView = {
    kind: `delta`,
    finished: [],
    // Carried at the status the snapshot gave it, which is what the row draws its glyph from.
    started: [{ ...LIST[1]!, status: `in_progress` }],
    parked: [LIST[0]!],
    added: 0,
    dropped: 0,
    doneBefore: 1,
    done: 1,
    total: 3,
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

    // The reason this component has two modes: the daemon re-sends the whole list per status flip, so drawing every
    // snapshot in full costs an N-task turn N² rows to say N things.
    it(`draws one line for a snapshot that only moved a row, not the list again`, async () => {
        const element = mount(LIST, false, MOVED);
        const line = element.querySelector(`button`)!;

        // The change itself: what finished, what it moved on to, and the ground the list gained doing it.
        expect(line.textContent).toContain(`Add the per-repo lock`);
        expect(line.textContent).toContain(`Serialize git write routes`);
        expect(line.textContent).toContain(`0→1 of 3`);
        // The row this snapshot did not touch is the one a reader has already read, so it is not redrawn.
        expect(element.textContent).not.toContain(`Typecheck, lint and test`);

        line.click();
        await Promise.resolve();
        expect(element.textContent).toContain(`Typecheck, lint and test`);
    });

    // A bare "1/3" sits where a status bar puts what is true NOW, and these rows are stamps from earlier in the turn.
    it(`states progress as the advance it made, never as a level a reader could take for the state now`, () => {
        const line = mount(LIST, false, MOVED).querySelector(`button`)!;
        expect(line.textContent).not.toMatch(/\b1\/3\b/u);
    });

    it(`prints no figure where the count held, so the same number can't appear on row after row`, () => {
        const line = mount(LIST, false, HANDED_OVER).querySelector(`button`)!;
        expect(line.textContent).not.toContain(`of 3`);
        expect(line.textContent).toContain(`Typecheck, lint and test`);
    });

    // The one move the finished/started pair reads as a completion: the baton passes, nothing got done.
    it(`names the task a snapshot moved on from without finishing`, () => {
        const line = mount(LIST, false, HANDED_OVER).querySelector(`button`)!;
        expect(line.textContent).toContain(`Serialize git write routes still open`);
        expect(line.querySelector(`[data-icon="check-circle"]`)).toBeNull();
    });

    it(`says in words what the icons and the arrow say by their arrangement`, () => {
        const element = mount(LIST, false, MOVED);
        expect(element.querySelector(`button`)?.getAttribute(`aria-label`)).toBe(
            `Show the checklist · finished Add the per-repo lock, started Serialize git write routes · 0 to 1 of 3 done at this point`,
        );
    });

    it(`says "still" for a snapshot that moved no count, where the figure itself is absent`, () => {
        const element = mount(LIST, false, HANDED_OVER);
        expect(element.querySelector(`button`)?.getAttribute(`aria-label`)).toBe(
            `Show the checklist · started Typecheck, lint and test, left Serialize git write routes open · still 1 of 3 done`,
        );
    });

    it(`draws the whole list when the view says full, so a turn's first snapshot still orients the reader`, () => {
        const element = mount(LIST, false, { kind: `full` });
        expect(element.querySelector(`button`)).toBeNull();
        expect(element.textContent).toContain(`Typecheck, lint and test`);
    });
});
