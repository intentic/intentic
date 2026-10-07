import "@intentic/testing/dom";
import { answerIn, showWaitingCard, waitingCardIn } from "../waitingCard";

// Where the waiting bar's press lands: the card for the ask it names (not merely the newest one waiting), given the
// keyboard at the answer the reader would press, and ringed, so a press beside a card already on screen still shows
// where to answer.

// A pane holding card rows the way ChatMessageView draws them: each row names its ask, each live card is marked.
const pane = (html: string): HTMLElement => {
    const root = document.createElement(`div`);
    root.innerHTML = html;
    document.body.append(root);
    return root;
};

const card = (requestId: string, body = ``): string =>
    `<div class="chat-message" data-card-request="${requestId}"><div class="chat-card" data-card-live id="card-${requestId}">${body}</div></div>`;

afterEach(() => {
    document.body.innerHTML = ``;
});

describe(`the card a waiting bar goes to`, () => {
    it(`is the one for the ask it names, even with a newer card waiting below it`, () => {
        const root = pane(`${card(`plan-1`)}${card(`offer-2`)}`);
        expect(waitingCardIn(root, `plan-1`)?.id).toBe(`card-plan-1`);
    });

    it(`is the newest waiting card while no row is drawn under the ask's id`, () => {
        const root = pane(`${card(`a`)}${card(`b`)}`);
        expect(waitingCardIn(root, `not-drawn-yet`)?.id).toBe(`card-b`);
        expect(waitingCardIn(pane(``), `none`)).toBeUndefined();
    });
});

describe(`what the press hands the keyboard to`, () => {
    it(`is a plan's card itself, whose answers stand on the bar`, () => {
        const root = pane(card(`p`, `<div class="chat-card-row"><button>Copy</button></div>`));
        const plan = waitingCardIn(root, `p`)!;
        expect(answerIn(plan, `plan`)).toBe(plan);
    });

    it(`is the option already picked, else the first offered`, () => {
        const options = `<button class="chat-option" id="one" aria-checked="false"></button><button class="chat-option" id="two" aria-checked="true"></button>`;
        expect(answerIn(waitingCardIn(pane(card(`q`, options)), `q`)!, `question`).id).toBe(`two`);
        document.body.innerHTML = ``;
        const fresh = options.replace(`aria-checked="true"`, `aria-checked="false"`);
        expect(answerIn(waitingCardIn(pane(card(`q`, fresh)), `q`)!, `question`).id).toBe(`one`);
    });

    it(`is the first answer on the card's own row that can still be pressed`, () => {
        const body = `<button id="disclose">Show command</button><div class="chat-card-row"><button id="busy" disabled>Allow</button><button id="deny">Deny</button></div>`;
        expect(answerIn(waitingCardIn(pane(card(`perm`, body)), `perm`)!, `permission`).id).toBe(`deny`);
    });
});

describe(`the press`, () => {
    it(`brings the card on screen, moves focus onto it and rings it`, () => {
        const root = pane(card(`p`));
        const plan = waitingCardIn(root, `p`)!;
        const scrolled = jest.fn();
        plan.scrollIntoView = scrolled;
        const rung = jest.fn((_frames: Keyframe[], _timing: KeyframeAnimationOptions) => ({}) as Animation);
        // SAFETY: the ring reads nothing back from the animation it starts, so a stand-in that only records suffices.
        plan.animate = rung as unknown as HTMLElement[`animate`];

        showWaitingCard(plan, `plan`);

        expect(scrolled).toHaveBeenCalledTimes(1);
        // Focusable from script only, so Tab still walks the answers rather than stopping on the card.
        expect(plan.getAttribute(`tabindex`)).toBe(`-1`);
        expect(document.activeElement).toBe(plan);
        expect(rung).toHaveBeenCalledTimes(1);
    });
});
