//
// jsdom for the one thing this module does beyond holding a string: it remembers. The cut is how this reader
// reads the chat list, so it has to survive the docked sheet being dismissed, the floating window being closed, and a
// reload: a preference that silently resets is one people stop using.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

// A reload is the module reading storage again, so every case loads its own copy.
const load = () => freshImport<typeof import("./chatGrouping")>("./chatGrouping", import.meta.url);

beforeEach(() => {
    localStorage.clear();
});

// The lanes are the default because they are the cut that always has an answer: every chat has a lane, while a
// workspace that has never made a persona would open on a single "Anyone" heading and nothing to compare it to.
it("starts on the lanes", async () => {
    const { useChatGrouping } = await load();
    expect(useChatGrouping().grouping.value).toBe(`lane`);
});

it("remembers the persona cut across a reload", async () => {
    const first = await load();
    first.useChatGrouping().set(`persona`);
    const second = await load();
    expect(second.useChatGrouping().grouping.value).toBe(`persona`);
});

// A value from a later build, or one edited by hand, must not land the reader on a cut this build cannot draw.
it("falls back to the lanes on a value it does not recognise", async () => {
    localStorage.setItem(`ui-chat-grouping`, `by-model`);
    const { useChatGrouping } = await load();
    expect(useChatGrouping().grouping.value).toBe(`lane`);
});

// Storage can refuse outright (private mode). The switch still has to work for this session.
it("still switches when storage refuses to be written", async () => {
    const setItem = jest.spyOn(Storage.prototype, `setItem`).mockImplementation(() => {
        throw new Error(`denied`);
    });
    const { useChatGrouping } = await load();
    const { grouping, set } = useChatGrouping();
    expect(() => set(`persona`)).not.toThrow();
    expect(grouping.value).toBe(`persona`);
    setItem.mockRestore();
});
