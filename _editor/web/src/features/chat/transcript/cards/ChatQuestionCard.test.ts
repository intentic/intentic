// Needs jsdom: Dismiss beside Send threw away an answer already picked and ended the turn, so with an answer under way
// it asks first.
import "@intentic/testing/dom";
import { ATTACHMENTS_DIR } from "@intentic/sandbox-contract/state/workspace-state";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, reactive } from "vue";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { forgetQuestionFiles, OTHER_LABEL, questionFiles, readQuestionDraft, writeQuestionDraft } from "../../drafts/questionDraft";
import type { PendingAttachment } from "../../drafts/useChatAttachments";
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
const mount = (message: ChatMessage = CARD): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(ChatQuestionCard, {
                message,
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
    forgetQuestionFiles(`q-dismiss`);
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

const SHOT = `${ATTACHMENTS_DIR}/a/shot.png`;

// A screenshot can be the whole of an own-words answer: Other with a file and no words still submits, carrying the file.
it(`submits a file attached to Other, under its question, with no words needed`, async () => {
    writeQuestionDraft(`q-dismiss`, { selections: { 0: [OTHER_LABEL] }, otherTexts: {}, otherFiles: { 0: [{ name: `shot.png`, path: SHOT }] } });
    const card = mount();
    await nextTick();

    expect(card.textContent).toContain(`shot.png`);
    await press(card, `Submit`);

    expect(sent).toEqual([
        { kind: `question`, answers: { "Which licence?": [`(see the attached file)`] }, attachments: { "Which licence?": [SHOT] } },
    ]);
});

// Files belong to the Other row: picking a listed option instead leaves them out of the answer.
it(`leaves a row's files out once a listed option is picked instead`, async () => {
    writeQuestionDraft(`q-dismiss`, { selections: { 0: [OTHER_LABEL] }, otherTexts: {}, otherFiles: { 0: [{ name: `shot.png`, path: SHOT }] } });
    const card = mount();
    await press(card, `MIT`);
    await press(card, `Submit`);

    expect(sent).toEqual([{ kind: `question`, answers: { "Which licence?": [`MIT`] } }]);
});

it(`shows the files that went with a decided answer`, async () => {
    const card = mount({
        ...CARD,
        question: { ...CARD.question!, status: `answered`, answers: { "Which licence?": [`like this`] }, attachments: { "Which licence?": [SHOT] } },
    });
    await nextTick();

    expect(card.textContent).toContain(`like this`);
    expect(card.textContent).toContain(`shot.png`);
});

// An upload outlives the card that started it (the pane closed, the transcript re-drawn) and lands on disk regardless:
// the card drawn again shows it still going, holds Submit for it, and puts it in the draft once it lands.
it(`picks up an upload a previous drawing of the card started, and drafts it once it lands`, async () => {
    const upload = reactive<PendingAttachment>({ id: `u1`, name: `shot.png`, path: SHOT, status: `uploading`, progress: 0.4 });
    questionFiles(`q-dismiss`, 0).value = [upload];
    writeQuestionDraft(`q-dismiss`, { selections: { 0: [OTHER_LABEL] }, otherTexts: {} });
    const card = mount();
    await nextTick();

    expect(card.textContent).toContain(`shot.png`);
    await press(card, `Submit`);
    expect(sent).toEqual([]);

    upload.status = `done`;
    upload.progress = 1;
    await nextTick();

    expect(readQuestionDraft(`q-dismiss`, CARD.question!.questions).otherFiles).toEqual({ 0: [{ name: `shot.png`, path: SHOT }] });
    await press(card, `Submit`);
    expect(sent).toEqual([
        { kind: `question`, answers: { "Which licence?": [`(see the attached file)`] }, attachments: { "Which licence?": [SHOT] } },
    ]);
});
