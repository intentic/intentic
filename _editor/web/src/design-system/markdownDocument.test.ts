import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ref } from "vue";
import { SAVE_AFTER_MS, type SavePolicy, useSaveDraft } from "@intentic/ui/markdown-document";

// The save policy behind <MarkdownDocument> (`@intentic/ui/markdown-document`), tested from here the way the block
// splitter is. No DOM: this is a decision about text, a baseline and a clock, all passed in. The case that matters
// most: opening a document to read it must never write it.

const DISK = `# On disk\n`;

// One draft under test, with the writes it asked for. `stored` moves only when a test says a write landed, matching
// what a caller does.
const draftOf = (policy: SavePolicy, disk: string | undefined = DISK) => {
    const text = ref(disk ?? ``);
    const stored = ref(disk);
    const saving = ref(false);
    const writes: string[] = [];
    const draft = useSaveDraft({
        policy: () => policy,
        text: () => text.value,
        stored: () => stored.value,
        saving: () => saving.value,
        write: (value: string) => writes.push(value),
    });
    // Typing: the model moves first, then the surface reports it, matching the component's own order.
    const type = (value: string): void => {
        text.value = value;
        draft.touched();
    };
    return { ...draft, text, stored, saving, writes, type };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe(`save="auto"`, () => {
    test(`writes once the typing stops, not once per keystroke`, () => {
        const it = draftOf(`auto`);
        it.type(`# On disk\nA`);
        it.type(`# On disk\nAb`);
        it.type(`# On disk\nAbc`);
        vi.advanceTimersByTime(SAVE_AFTER_MS - 1);
        expect(it.writes).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(it.writes).toEqual([`# On disk\nAbc`]);
    });

    // The one that matters: a row that opens a story or a pane that loads a note both call into this on mount, and a
    // debounce firing on an untouched file would dirty every document anybody looks at.
    test(`never writes a document that was only read`, () => {
        const it = draftOf(`auto`);
        // Nothing typed: the surface mounted, the reader looked at it, and the clock ran on.
        vi.advanceTimersByTime(SAVE_AFTER_MS * 10);
        expect(it.writes).toEqual([]);
    });

    test(`nor one typed back to exactly what disk holds`, () => {
        const it = draftOf(`auto`);
        it.type(`${DISK}oops`);
        it.type(DISK);
        vi.advanceTimersByTime(SAVE_AFTER_MS * 2);
        expect(it.writes).toEqual([]);
    });

    test(`the last sentence is written on the way out, ahead of the timer`, () => {
        const it = draftOf(`auto`);
        it.type(`${DISK}half a sen`);
        it.leave();
        expect(it.writes).toEqual([`${DISK}half a sen`]);
        // And the timer it cancelled does not then write the same text a second time.
        vi.advanceTimersByTime(SAVE_AFTER_MS * 2);
        expect(it.writes).toHaveLength(1);
    });

    test(`leaving an untouched document writes nothing`, () => {
        const it = draftOf(`auto`);
        it.leave();
        expect(it.writes).toEqual([]);
    });
});

describe(`save="explicit"`, () => {
    test(`typing schedules nothing: this is text every turn reads, and it waits to be told`, () => {
        const it = draftOf(`explicit`);
        it.type(`${DISK}a new rule`);
        vi.advanceTimersByTime(SAVE_AFTER_MS * 10);
        expect(it.writes).toEqual([]);
    });

    test(`the button (or Ctrl-S) writes it`, () => {
        const it = draftOf(`explicit`);
        it.type(`${DISK}a new rule`);
        it.commit();
        expect(it.writes).toEqual([`${DISK}a new rule`]);
    });

    // Nothing is flushed on the way out: the reader chose not to save, and writing a half-composed draft as they
    // navigate away would be exactly the surprise `explicit` prevents.
    test(`leaving discards, because not saving was a decision`, () => {
        const it = draftOf(`explicit`);
        it.type(`${DISK}half a rule`);
        it.leave();
        expect(it.writes).toEqual([]);
    });

    test(`pressing Save on an unchanged document writes nothing`, () => {
        const it = draftOf(`explicit`);
        it.commit();
        expect(it.writes).toEqual([]);
    });
});

describe(`save="none"`, () => {
    test(`the form owns the save, so typing and leaving both write nothing`, () => {
        const it = draftOf(`none`);
        it.type(`${DISK}typed`);
        vi.advanceTimersByTime(SAVE_AFTER_MS * 10);
        it.leave();
        expect(it.writes).toEqual([]);
    });

    // Ctrl-S must still reach the caller: under `none` the workspace file viewer is what saves, and a swallowed
    // shortcut would do nothing.
    test(`but an explicit commit is forwarded, so Ctrl-S reaches whoever does own it`, () => {
        const it = draftOf(`none`);
        it.type(`${DISK}typed`);
        it.commit();
        expect(it.writes).toEqual([`${DISK}typed`]);
    });
});

// A caller that does not track disk has not said nothing changed, so it decides; this is the workspace file viewer's
// shape, holding dirty state against the bytes it read.
describe(`with no 'stored' handed over`, () => {
    test(`reports nothing as unsaved, and forwards every explicit save`, () => {
        const it = draftOf(`none`, undefined);
        expect(it.dirty.value).toBe(false);
        it.type(`anything`);
        it.commit();
        expect(it.writes).toEqual([`anything`]);
    });
});

describe(`the status line`, () => {
    test(`says nothing about a document nobody has touched`, () => {
        expect(draftOf(`auto`).status.value).toBe(``);
    });

    test(`names the promise each policy is making`, () => {
        const auto = draftOf(`auto`);
        auto.type(`${DISK}x`);
        expect(auto.status.value).toBe(`Unsaved`);

        const explicit = draftOf(`explicit`);
        explicit.type(`${DISK}x`);
        expect(explicit.status.value).toBe(`Not saved yet`);
    });

    test(`a write in flight outranks both`, () => {
        const it = draftOf(`auto`);
        it.type(`${DISK}x`);
        it.saving.value = true;
        expect(it.status.value).toBe(`Saving…`);
    });

    // "Saved" means a write just happened. A document matching disk because nobody touched it is simply the file, not a
    // save the surface performed.
    test(`"Saved" appears only after a write this surface asked for lands`, async () => {
        const it = draftOf(`auto`);
        it.type(`${DISK}x`);
        it.saving.value = true;
        await Promise.resolve();
        it.stored.value = `${DISK}x`;
        it.saving.value = false;
        await Promise.resolve();
        expect(it.status.value).toBe(`Saved`);
    });

    test(`and goes again the moment anything else is typed`, async () => {
        const it = draftOf(`auto`);
        it.type(`${DISK}x`);
        it.saving.value = true;
        await Promise.resolve();
        it.stored.value = `${DISK}x`;
        it.saving.value = false;
        await Promise.resolve();
        it.type(`${DISK}xy`);
        await Promise.resolve();
        expect(it.status.value).toBe(`Unsaved`);
    });

    test(`stays silent under "none", where this component is not the thing that saves`, () => {
        const it = draftOf(`none`);
        it.type(`${DISK}x`);
        expect(it.status.value).toBe(``);
    });
});
