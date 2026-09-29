// Needs jsdom: Dismiss beside Send threw away an answer already picked and ended the turn, so with an answer under way
// it asks first.
import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick } from "vue";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import ChatQuestionCard from "./ChatQuestionCard.vue";

const CARD: ChatMessage = {
    id: 2,
    role: `assistant`,
    text: ``,
    question: {
        requestId: `q-dismiss`,
        status: `pending`,
        questions: [
            {
                question: `Which licence?`,
                header: `Licence`,
                multiSelect: false,
                options: [
                    { label: `MIT`, description: `` },
                    { label: `Apache-2.0`, description: `` },
                ],
            },
        ],
    },
};

let app: App | undefined;
const sent: CardAnswer[] = [];
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(ChatQuestionCard, {
                message: CARD,
                settling: false,
                reply: async (answer: CardAnswer) => {
                    sent.push(answer);
                },
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    sent.length = 0;
    localStorage.clear();
});

const labels = (element: HTMLElement): string[] => [...element.querySelectorAll(`button`)].map((button) => button.textContent?.trim() ?? ``);
const press = async (element: HTMLElement, label: string): Promise<void> => {
    const button = [...element.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim().startsWith(label));
    if (button === undefined) {
        throw new Error(`no "${label}" on the card`);
    }
    button.click();
    await nextTick();
};

it(`dismisses at once while nothing is picked`, async () => {
    const card = mount();

    await press(card, `Dismiss`);

    expect(sent).toEqual([{ kind: `question`, cancelled: true }]);
});

it(`asks before dismissing a picked answer, and keeps it on "Keep my answer"`, async () => {
    const card = mount();
    await press(card, `MIT`);

    await press(card, `Dismiss`);
    expect(sent).toEqual([]);
    expect(card.textContent).toContain(`Dismissing drops the answer you picked and stops the turn.`);
    expect(labels(card).slice(-3)).toEqual([`Submit`, `Dismiss anyway`, `Keep my answer`]);

    await press(card, `Keep my answer`);
    expect(labels(card).slice(-2)).toEqual([`Submit`, `Dismiss`]);
    await press(card, `Dismiss`);
    await press(card, `Dismiss anyway`);
    expect(sent).toEqual([{ kind: `question`, cancelled: true }]);
});
