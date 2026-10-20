import { STATE_DIR } from "@intentic/constants";
import { storedOutbox, storeOutbox, type OutboxEntry } from "./sendOutbox";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";

// The outbox outlives the page: a reload or an update of the app must not lose words the sandbox never had, and must not
// send one this build can no longer read.
describe(`the outbox's own storage`, () => {
    const entries = new Map<string, string>();
    beforeEach(() => {
        entries.clear();
        stubGlobal(`localStorage`, {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            key: (index: number) => [...entries.keys()][index] ?? null,
            get length() {
                return entries.size;
            },
            clear: () => entries.clear(),
        });
    });
    afterEach(() => {
        unstubAllGlobals();
    });

    const waiting = (messageId: string, text: string): OutboxEntry => ({
        messageId,
        text,
        attachments: [{ name: `a.png`, path: `${STATE_DIR}/records/artifacts/attachments/x/a.png` }],
        body: { messageId, prompt: text, conversationId: `calm-river-ab12`, agent: `claude` },
        sentAt: 1_000,
    });

    it(`keeps each conversation's waiting words, in order, apart from every other's`, () => {
        storeOutbox(`sb1`, `calm-river-ab12`, [waiting(`m1`, `first`), waiting(`m2`, `second`)]);
        storeOutbox(`sb1`, `other-tab-cd34`, [waiting(`m3`, `elsewhere`)]);

        expect(storedOutbox(`sb1`, `calm-river-ab12`).map((entry) => entry.text)).toEqual([`first`, `second`]);
        expect(storedOutbox(`sb1`, `other-tab-cd34`).map((entry) => entry.text)).toEqual([`elsewhere`]);
        // Another sandbox's tabs are another sandbox's.
        expect(storedOutbox(`sb2`, `calm-river-ab12`)).toEqual([]);
    });

    it(`forgets a conversation once nothing waits in it`, () => {
        storeOutbox(`sb1`, `calm-river-ab12`, [waiting(`m1`, `first`)]);
        storeOutbox(`sb1`, `calm-river-ab12`, []);
        expect(storedOutbox(`sb1`, `calm-river-ab12`)).toEqual([]);
        expect([...entries.values()].join(``)).not.toContain(`calm-river-ab12`);
    });

    it(`reads nothing it could not send: a request of the wrong shape is dropped, not sent malformed`, () => {
        storeOutbox(`sb1`, `calm-river-ab12`, [waiting(`m1`, `first`)]);
        const [key] = [...entries.keys()];
        entries.set(key!, JSON.stringify({ conversations: { "calm-river-ab12": [{ ...waiting(`m1`, `first`), body: { prompt: 7 } }] } }));
        expect(storedOutbox(`sb1`, `calm-river-ab12`)).toEqual([]);
    });
});
