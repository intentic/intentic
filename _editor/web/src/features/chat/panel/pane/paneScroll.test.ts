import "@intentic/testing/dom";
import { effectScope, nextTick, ref } from "vue";

// Pins when the pane moves its own scroller: to the newest message when another transcript comes on screen or a strip
// shows the turns it withheld, and after every row it follows. Whether the reader scrolled up, which decides if a
// follow moves anything, is the scroller's own rule (useStickToBottom), stood in for here.

const { pin, follow } = { pin: jest.fn(), follow: jest.fn() };
jest.mock("../../transcript/useStickToBottom", () => ({ useStickToBottom: () => ({ pin, follow }) }));
const { usePaneScroll } = await import("./paneScroll");

const paneOf = () => {
    const state = { conversationId: ref(`c1`), bare: ref<boolean | undefined>(false), messageCount: ref(0), streaming: ref(false), grow: jest.fn() };
    effectScope().run(() =>
        usePaneScroll({
            scroller: ref(null),
            content: ref(null),
            conversationId: () => state.conversationId.value,
            bare: () => state.bare.value,
            messageCount: () => state.messageCount.value,
            streaming: state.streaming,
            grow: state.grow,
        }),
    );
    return state;
};

afterEach(() => {
    pin.mockClear();
    follow.mockClear();
});

it(`starts another chat at its newest message, sized to its own draft`, async () => {
    const state = paneOf();

    state.conversationId.value = `c2`;
    await nextTick();

    expect(pin).toHaveBeenCalledTimes(1);
    expect(state.grow).toHaveBeenCalledTimes(1);
});

it(`starts a strip's turns at the newest when they are shown, and moves nothing as they are withheld`, async () => {
    const state = paneOf();

    state.bare.value = true;
    await nextTick();
    expect(pin).not.toHaveBeenCalled();

    state.bare.value = false;
    await nextTick();
    expect(pin).toHaveBeenCalledTimes(1);
});

it(`follows each new row and each edge of a turn, and pins nothing for them`, async () => {
    const state = paneOf();

    state.messageCount.value = 2;
    await nextTick();
    state.streaming.value = true;
    await nextTick();

    expect(follow).toHaveBeenCalledTimes(2);
    expect(pin).not.toHaveBeenCalled();
});
