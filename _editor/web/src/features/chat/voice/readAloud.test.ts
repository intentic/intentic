import { shallowRef } from "vue";
import { excerptOf, type Reading, type ReadAloudView, readAloud, readAloudNotice } from "./readAloud";
import type { SpeechEnd, SpeechPlayer, SpeechPlayerState } from "../../../models/voice/speechPlayer";

// What the person is told while a reply is read aloud: the stage in words while the press can only spin, Stop on the
// card for a reply scrolled away, and the reason when it fails. A stop they asked for is not news.

jest.mock(`../../../client/sandbox/streams/wsTicket`, () => ({ socketUrl: async () => undefined }));

const read: Reading = { key: `read:m1`, excerpt: `Fixed the login form` };
const view = (over: Partial<ReadAloudView>): ReadAloudView => ({ state: `preparing`, speaking: read.key, progress: undefined, notice: undefined, ...over });
const stop = (): void => undefined;

describe(`the read-aloud card`, () => {
    it(`says the voice is getting ready, and which reply, before the first word`, () => {
        const card = readAloudNotice(view({}), read, stop);
        expect(card?.kind).toBe(`condition`);
        expect(card?.spin).toBe(true);
        expect(card?.detail).toBe(`“Fixed the login form”`);
        expect(card?.actions).toHaveLength(1);
    });

    it(`counts a first download in percent and says it happens once`, () => {
        const card = readAloudNotice(view({ state: `downloading`, progress: 0.424 }), read, stop);
        expect(card?.title).toContain(`42`);
        expect(card?.detail).not.toBe(`“Fixed the login form”`);
    });

    it(`stops spinning once it speaks, and carries a failover's words over the excerpt`, () => {
        expect(readAloudNotice(view({ state: `speaking` }), read, stop)?.spin).toBeUndefined();
        const failedOver = `ElevenLabs could not speak, so this sandbox's own voice is speaking instead.`;
        expect(readAloudNotice(view({ state: `speaking`, notice: failedOver }), read, stop)?.detail).toBe(failedOver);
    });

    it(`stands down when the voice is idle or says something else (hands-free, a preview)`, () => {
        expect(readAloudNotice(view({ state: `idle`, speaking: undefined }), read, stop)).toBeUndefined();
        expect(readAloudNotice(view({ speaking: `talk:c1:m2` }), read, stop)).toBeUndefined();
        expect(readAloudNotice(view({}), undefined, stop)).toBeUndefined();
    });

    it(`puts Stop on the card`, () => {
        let stopped = false;
        const card = readAloudNotice(view({ state: `speaking` }), read, () => {
            stopped = true;
        });
        void card?.actions?.[0]?.run();
        expect(stopped).toBe(true);
    });
});

describe(`a reply's excerpt`, () => {
    it(`is its first line of prose, without markdown`, () => {
        expect(excerptOf(`## Done\n\nThe **form** now rejects it.`)).toBe(`Done`);
        expect(excerptOf("```ts\nconst a = 1;\n```\n- See [the docs](https://x.dev) for `why`")).toBe(`See the docs for why`);
    });

    it(`is cut short with an ellipsis`, () => {
        const excerpt = excerptOf(`word `.repeat(40));
        expect(excerpt.length).toBeLessThanOrEqual(72);
        expect(excerpt.endsWith(`…`)).toBe(true);
    });
});

describe(`reading a reply aloud`, () => {
    const player = (end: SpeechEnd, notice?: string) => {
        const said: string[] = [];
        return {
            said,
            player: {
                state: shallowRef<SpeechPlayerState>(`idle`),
                speaking: shallowRef<string | undefined>(),
                progress: shallowRef<number | undefined>(),
                notice: shallowRef<string | undefined>(notice),
                say: async (text) => {
                    said.push(text);
                    return end;
                },
                stop: () => undefined,
            } satisfies SpeechPlayer,
        };
    };

    it(`asks the player for the whole reply`, async () => {
        const fake = player(`done`);
        await readAloud(`The whole reply.`, `read:m1`, fake.player);
        expect(fake.said).toEqual([`The whole reply.`]);
    });

    it(`reports a failure with the player's reason`, async () => {
        const { useNotifications } = await import(`../../../workbench/notifications/notifications`);
        const notifications = useNotifications();
        notifications.dismissReceipt();
        await readAloud(`Reply.`, `read:m1`, player(`failed`, `The sandbox could not be reached to speak.`).player);
        expect(notifications.receipt.value?.tone).toBe(`problem`);
        expect(notifications.receipt.value?.detail).toBe(`The sandbox could not be reached to speak.`);
    });

    it(`says nothing when the person stopped it`, async () => {
        const { useNotifications } = await import(`../../../workbench/notifications/notifications`);
        const notifications = useNotifications();
        notifications.dismissReceipt();
        await readAloud(`Reply.`, `read:m1`, player(`stopped`).player);
        expect(notifications.receipt.value).toBeUndefined();
    });
});
