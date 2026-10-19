// The full-window view opens only when asked, only for a picture or a video, and hands the keyboard back where it ended.
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { ref } from "vue";
import { useHomeLightbox } from "./useHomeLightbox";

const file = (name: string): WorkspaceTreeEntry => ({ name, path: `shots/${name}`, type: `file`, size: 1 });
const ORDER = [file(`notes.md`), file(`a.png`), file(`clip.mp4`), file(`b.jpg`)];

const setup = (gallery = true) => {
    const focused: number[] = [];
    let looksClosed = 0;
    const on = ref(gallery);
    const lightbox = useHomeLightbox(
        () => ORDER,
        () => on.value,
        async (at) => {
            focused.push(at);
        },
        () => {
            looksClosed += 1;
        },
    );
    return { lightbox, focused, looksClosed: () => looksClosed, on };
};

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent(`keydown`, { cancelable: true, ...init });

it(`steps through the folder's pictures and videos alone, in the home's order`, () => {
    expect(setup().lightbox.viewable.value.map((entry) => entry.name)).toEqual([`a.png`, `clip.mp4`, `b.jpg`]);
});

it(`opens on Space over a selected picture, and closes the hover card it replaces`, () => {
    const { lightbox, looksClosed } = setup();
    const space = key({ key: ` ` });
    expect(lightbox.onSpace(space, ORDER[1])).toBe(true);
    expect(space.defaultPrevented).toBe(true);
    expect(lightbox.viewing.value).toBe(`shots/a.png`);
    expect(looksClosed()).toBe(1);
});

it(`leaves Space to the filter on anything else, and a chord alone`, () => {
    const { lightbox } = setup();
    expect(lightbox.onSpace(key({ key: ` ` }), ORDER[0])).toBe(false);
    expect(lightbox.onSpace(key({ key: ` ` }), undefined)).toBe(false);
    expect(lightbox.onSpace(key({ key: ` `, ctrlKey: true }), ORDER[1])).toBe(false);
    expect(lightbox.viewing.value).toBeUndefined();
});

it(`hands the keyboard back to the tile it ended on`, () => {
    const { lightbox, focused } = setup();
    lightbox.closed(`shots/b.jpg`);
    lightbox.closed(`shots/gone.png`);
    expect(focused).toEqual([3]);
});

it(`raises no hover card over a gallery's picture, and still over a grid's or a gallery's text file`, () => {
    const { lightbox, on } = setup();
    expect(lightbox.inPlace(ORDER[1]!)).toBe(true);
    expect(lightbox.inPlace(ORDER[0]!)).toBe(false);
    on.value = false;
    expect(lightbox.inPlace(ORDER[1]!)).toBe(false);
});
