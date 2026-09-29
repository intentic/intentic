import { effectScope, nextTick, ref } from "vue";
import { queueAttachment, takeQueuedAttachments, useQueuedAttachments } from "./pendingAttachments";

// A file handed to a chat from outside its composer waits here until the composer showing that chat takes it: on mount,
// or when it lands, and only once that composer can upload at all. The composer's own `attach` is stood in for.

const file = (name: string): File => new File([`bytes of ${name}`], name, { type: `text/plain` });

// A composer for `conversationId`, mounted in a scope the test ends: what its `attach` was handed, and when the queue
// said the file was taken.
const composer = (conversationId: string, reachable = ref(true)) => {
    const attached: string[] = [];
    const scope = effectScope();
    scope.run(() =>
        useQueuedAttachments({
            conversationId: () => conversationId,
            reachable: () => reachable.value,
            attach: (taken) => attached.push(taken.name),
        }),
    );
    return { attached, reachable, stop: () => scope.stop() };
};

const stops: (() => void)[] = [];
afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    // Whatever a case left queued goes with it.
    takeQueuedAttachments(`c-1`);
    takeQueuedAttachments(`c-2`);
});

describe(`files queued for a chat`, () => {
    it(`are taken by that chat's composer on mount, in the order they came, and said to be taken`, () => {
        const said: string[] = [];
        queueAttachment({ conversationId: `c-1`, file: file(`brief.docx`), taken: () => said.push(`brief.docx`) });
        queueAttachment({ conversationId: `c-1`, file: file(`notes.md`) });
        const mounted = composer(`c-1`);
        stops.push(mounted.stop);
        expect(mounted.attached).toEqual([`brief.docx`, `notes.md`]);
        expect(said).toEqual([`brief.docx`]);
        expect(takeQueuedAttachments(`c-1`)).toEqual([]);
    });

    it(`are taken when they land under a composer already showing the chat`, async () => {
        const mounted = composer(`c-1`);
        stops.push(mounted.stop);
        queueAttachment({ conversationId: `c-1`, file: file(`brief.docx`) });
        await nextTick();
        expect(mounted.attached).toEqual([`brief.docx`]);
    });

    it(`are left to their own chat's composer, and taken by only one`, async () => {
        const other = composer(`c-2`);
        const first = composer(`c-1`);
        const second = composer(`c-1`);
        stops.push(other.stop, first.stop, second.stop);
        queueAttachment({ conversationId: `c-1`, file: file(`brief.docx`) });
        await nextTick();
        expect(other.attached).toEqual([]);
        expect([...first.attached, ...second.attached]).toEqual([`brief.docx`]);
    });

    it(`wait while the composer can't upload, and are taken once it can`, async () => {
        const reachable = ref(false);
        queueAttachment({ conversationId: `c-1`, file: file(`brief.docx`) });
        const mounted = composer(`c-1`, reachable);
        stops.push(mounted.stop);
        expect(mounted.attached).toEqual([]);
        reachable.value = true;
        await nextTick();
        expect(mounted.attached).toEqual([`brief.docx`]);
    });
});
