import type { VoiceSettings } from "@intentic/sandbox-contract/schemas/voice";
import { computed, createApp, defineComponent, h, nextTick, ref, shallowRef } from "vue";
import type { CardAnswer } from "../../../models/conversations/session/cardReplies";
import type { ChatMessage } from "../../../models/conversations/transcript/transcript";
import type { SayOptions, SpeechEnd, SpeechPlayer, SpeechPlayerState } from "../../../models/voice/speechPlayer";
import type { CardWords } from "./voiceCards";

// Pins the agent answering out loud while hands-free is on: a finished turn's reply said short, a card put to the person
// and answered by what they say next, the mic resting while the voice speaks, and talking over it stopping it when the
// owner allowed that.

jest.mock(`../../../client/sandbox/streams/wsTicket`, () => ({ socketUrl: async () => undefined }));

const { useVoiceTalk } = await import(`./useVoiceTalk`);

const words: CardWords = {
    question: (question, options) => `${question} ${options}?`,
    questions: (count) => `${count} questions.`,
    permission: (action) => `Allow ${action}?`,
    plan: (title) => `Plan ${title}?`,
    or: `or`,
};

interface Said {
    readonly text: string;
    readonly options: SayOptions;
}

const fakePlayer = () => {
    const said: Said[] = [];
    const state = shallowRef<SpeechPlayerState>(`idle`);
    const speaking = shallowRef<string | undefined>();
    let settle: ((end: SpeechEnd) => void) | undefined;
    const end = (how: SpeechEnd): void => {
        speaking.value = undefined;
        state.value = `idle`;
        settle?.(how);
    };
    const player: SpeechPlayer = {
        state,
        speaking,
        progress: shallowRef(),
        notice: shallowRef(),
        say: (text, options) => {
            said.push({ text, options });
            speaking.value = options.key;
            state.value = `speaking`;
            return new Promise((resolve) => {
                settle = resolve;
            });
        },
        stop: () => end(`stopped`),
    };
    return { player, said, end };
};

let nextId = 1;
const row = (fields: Partial<ChatMessage> & Pick<ChatMessage, `role`>): ChatMessage => ({ id: nextId++, text: ``, ...fields });

const mounted = (settings: Partial<VoiceSettings> = {}) => {
    const fake = fakePlayer();
    const on = ref(true);
    const talking = ref(false);
    const deaf: boolean[] = [];
    const messages = shallowRef<readonly ChatMessage[]>([]);
    const streaming = ref(false);
    const awaitingDecision = ref(false);
    const replies: { readonly requestId: string; readonly answer: CardAnswer }[] = [];
    let talk!: ReturnType<typeof useVoiceTalk>;
    const app = createApp(
        defineComponent({
            setup() {
                talk = useVoiceTalk({
                    voice: { on: computed(() => on.value), speaking: talking, rest: (resting) => deaf.push(resting) },
                    messages,
                    streaming,
                    awaitingDecision,
                    conversationId: () => `c-1`,
                    reply: async (requestId, answer) => {
                        replies.push({ requestId, answer });
                        return true;
                    },
                    settings: ref({ replies: true, interrupt: false, speed: 1, voices: {}, wake: { word: `Leon` }, ...settings }),
                    player: fake.player,
                    words,
                });
                return () => h(`div`);
            },
        }),
    );
    app.mount(document.createElement(`div`));
    return { talk, on, talking, deaf, messages, streaming, awaitingDecision, replies, app, ...fake };
};

describe(`a finished turn while hands-free is on`, () => {
    it(`is answered out loud, once, as a short reply to what was asked`, async () => {
        const pane = mounted();
        pane.streaming.value = true;
        await nextTick();
        pane.messages.value = [row({ role: `user`, text: `Popraw logowanie` }), row({ role: `assistant`, text: `Done, the form rejects empty passwords.` })];
        pane.streaming.value = false;
        await nextTick();
        expect(pane.said).toHaveLength(1);
        expect(pane.said[0]).toMatchObject({
            text: `Done, the form rejects empty passwords.`,
            options: { as: `reply`, asked: `Popraw logowanie`, conversationId: `c-1` },
        });
        // A second end of the same turn (a reconnect re-reading it) says nothing again.
        pane.streaming.value = true;
        await nextTick();
        pane.streaming.value = false;
        await nextTick();
        expect(pane.said).toHaveLength(1);
    });

    it(`is not spoken with hands-free off, or with spoken replies switched off`, async () => {
        for (const pane of [
            (() => {
                const off = mounted();
                off.on.value = false;
                return off;
            })(),
            mounted({ replies: false }),
        ]) {
            pane.messages.value = [row({ role: `user`, text: `Hi` }), row({ role: `assistant`, text: `Hello.` })];
            pane.streaming.value = true;
            await nextTick();
            pane.streaming.value = false;
            await nextTick();
            expect(pane.said).toHaveLength(0);
        }
    });
});

describe(`the mic while the voice speaks`, () => {
    it(`rests while this pane's voice speaks and wakes after`, async () => {
        const pane = mounted();
        pane.messages.value = [row({ role: `user`, text: `Hi` }), row({ role: `assistant`, text: `Hello.` })];
        pane.streaming.value = true;
        await nextTick();
        pane.streaming.value = false;
        await nextTick();
        await nextTick();
        expect(pane.deaf.at(-1)).toBe(true);
        expect(pane.talk.hint.value).toEqual(expect.any(String));
        pane.end(`done`);
        await nextTick();
        expect(pane.deaf.at(-1)).toBe(false);
        expect(pane.talk.hint.value).toBeUndefined();
    });

    it(`stays open when talking over it is allowed, and talking stops the voice`, async () => {
        const pane = mounted({ interrupt: true });
        pane.messages.value = [row({ role: `user`, text: `Hi` }), row({ role: `assistant`, text: `Hello.` })];
        pane.streaming.value = true;
        await nextTick();
        pane.streaming.value = false;
        await nextTick();
        expect(pane.deaf.includes(true)).toBe(false);
        pane.talking.value = true;
        await nextTick();
        expect(pane.player.speaking.value).toBeUndefined();
    });

    it(`lets go of the mic and the voice when the pane goes`, async () => {
        const pane = mounted();
        pane.messages.value = [row({ role: `user`, text: `Hi` }), row({ role: `assistant`, text: `Hello.` })];
        pane.streaming.value = true;
        await nextTick();
        pane.streaming.value = false;
        await nextTick();
        pane.app.unmount();
        expect(pane.deaf.at(-1)).toBe(false);
        expect(pane.player.speaking.value).toBeUndefined();
    });
});

describe(`a card waiting while hands-free is on`, () => {
    const permission = (): ChatMessage =>
        row({ role: `assistant`, permission: { requestId: `p-1`, status: `pending`, toolName: `Bash`, displayName: `run the tests` } });

    it(`is put to the person, and what they say next answers it instead of queuing behind it`, async () => {
        const pane = mounted();
        pane.messages.value = [row({ role: `user`, text: `Fix it` }), permission()];
        pane.awaitingDecision.value = true;
        await nextTick();
        expect(pane.said.map(({ text }) => text)).toEqual([`Allow run the tests?`]);
        expect(pane.talk.intercept(`Yes please`)).toBe(true);
        expect(pane.replies).toEqual([{ requestId: `p-1`, answer: { kind: `permission`, decision: `once` } }]);
        // Answered: the next words are a message again.
        expect(pane.talk.intercept(`and add a test`)).toBe(false);
    });

    it(`says it did not catch an answer it cannot read, and keeps the card waiting`, async () => {
        const pane = mounted();
        pane.messages.value = [permission()];
        pane.awaitingDecision.value = true;
        await nextTick();
        expect(pane.talk.intercept(`what does it do`)).toBe(true);
        expect(pane.replies).toEqual([]);
        expect(pane.said).toHaveLength(2);
        expect(pane.talk.intercept(`no`)).toBe(true);
        expect(pane.replies[0]?.answer).toMatchObject({ decision: `deny` });
    });

    it(`leaves words alone when no card waits`, () => {
        expect(mounted().talk.intercept(`hello`)).toBe(false);
    });
});
