import "@intentic/testing/dom";
import { answerIn, askRowIn, focusAsk, revealRow, roomAbove, scrollToShow } from "../waitingCard";

// Between an ask in the dock above the composer and the row it was asked in: the dock's answer is handed the keyboard and
// ringed, and a row is brought into the room the sticky footer leaves, not centred behind it.

const pane = (html: string): HTMLElement => {
    const root = document.createElement(`div`);
    root.innerHTML = html;
    document.body.append(root);
    return root;
};

const box = (top: number, bottom: number) => (): DOMRect => DOMRect.fromRect({ x: 0, y: top, width: 0, height: bottom - top });

// The ring as the animations it starts: a stand-in that only records them, since the ring reads nothing back.
const ringOf = (el: HTMLElement): ReturnType<typeof jest.fn> => {
    const rung = jest.fn();
    el.animate = rung;
    return rung;
};

afterEach(() => {
    document.body.innerHTML = ``;
});

describe(`the row an ask was made in`, () => {
    it(`is found by the key the dock lists it under`, () => {
        const root = pane(`<div data-ask-row="card:a" id="a"></div><div data-ask-row="need:b" id="b"></div>`);
        expect(askRowIn(root, `need:b`)?.id).toBe(`b`);
        expect(askRowIn(root, `card:none`)).toBeUndefined();
    });
});

describe(`what the dock hands the keyboard to`, () => {
    it(`is the option already picked, else the first offered`, () => {
        const options = `<button class="chat-option" id="one" aria-checked="false"></button><button class="chat-option" id="two" aria-checked="true"></button>`;
        expect(answerIn(pane(options), `question`).id).toBe(`two`);
        expect(answerIn(pane(options.replace(`aria-checked="true"`, `aria-checked="false"`)), `question`).id).toBe(`one`);
    });

    it(`is the first answer on the card's own row that can still be pressed`, () => {
        const body = pane(`<button id="disclose">Show command</button><div class="chat-card-row"><button id="busy" disabled>Allow</button><button id="deny">Deny</button></div>`);
        expect(answerIn(body, `permission`).id).toBe(`deny`);
    });

    it(`is a plan's body itself, read from its top, and is ringed`, () => {
        const body = pane(`<button>Approve</button>`);
        const rung = ringOf(body);
        focusAsk(body, `plan`);
        // Focusable from script only, so Tab still walks the answers rather than stopping on the body.
        expect(body.getAttribute(`tabindex`)).toBe(`-1`);
        expect(document.activeElement).toBe(body);
        expect(rung).toHaveBeenCalledTimes(2);
    });
});

describe(`bringing a row on screen`, () => {
    const ROOM = { top: 0, bottom: 300 };

    it(`moves nothing for a row already wholly in the room above the footer`, () => {
        expect(scrollToShow({ top: 100, bottom: 140 }, ROOM)).toBe(0);
    });

    // On a phone the footer is half the screen: a row centred in the whole scroller sat behind the composer.
    it(`centres a row under the footer in the room the footer leaves, and puts a taller one's head at the top`, () => {
        expect(scrollToShow({ top: 500, bottom: 540 }, ROOM)).toBe(370);
        expect(scrollToShow({ top: 500, bottom: 1000 }, ROOM)).toBe(488);
    });

    it(`measures that room from the footer's own top, scrolls by the difference, and rings the row`, () => {
        const scroller = document.createElement(`div`);
        const footer = document.createElement(`div`);
        const row = document.createElement(`div`);
        scroller.append(row, footer);
        document.body.append(scroller);
        scroller.getBoundingClientRect = box(0, 800);
        footer.getBoundingClientRect = box(400, 800);
        row.getBoundingClientRect = box(500, 540);
        const scrolled = jest.fn();
        scroller.scrollBy = scrolled;
        const rung = ringOf(row);

        expect(roomAbove(scroller, footer)).toBe(400);
        revealRow(row, scroller, footer);

        expect(scrolled.mock.calls).toEqual([[{ top: 320, behavior: expect.any(String) }]]);
        expect(rung).toHaveBeenCalledTimes(2);
    });
});
