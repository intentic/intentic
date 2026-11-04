import { effectScope, nextTick, ref } from "vue";
import type { ViewScope } from "../../../app/workspaceScope";
import { SETTLE_MS, sameBytes, useLiveFile, viewerRefresh, type ViewerReading } from "./liveFile";

// A file written while it is open: when it reads as live, the read once its writes settle, and a drawn viewer taking
// the new bytes in place.

// A blob's bytes come back on a later turn of the loop than a promise's, so the wait is a few of those.
const flush = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

describe(`useLiveFile`, () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it(`reads as live once the file changes while open, and not after it has been quiet a while`, async () => {
        const epoch = ref(1);
        const scope = effectScope();
        const live = scope.run(() => useLiveFile(() => ({ agent: `c-1` }) satisfies ViewScope, () => epoch.value))!;
        expect(live.live.value).toBe(false);
        epoch.value = 2;
        await nextTick();
        expect(live.live.value).toBe(true);
        jest.advanceTimersByTime(30_001);
        expect(live.live.value).toBe(false);
        scope.stop();
    });

    it(`reads once the writes go quiet, the wait starting over with each write`, () => {
        const scope = effectScope();
        const live = scope.run(() => useLiveFile(() => ({}), () => 0))!;
        const reads: string[] = [];
        live.settle(() => reads.push(`first`));
        jest.advanceTimersByTime(SETTLE_MS - 1);
        live.settle(() => reads.push(`second`));
        jest.advanceTimersByTime(SETTLE_MS - 1);
        expect(reads).toEqual([]);
        jest.advanceTimersByTime(1);
        expect(reads).toEqual([`second`]);
        scope.stop();
    });
});

describe(`sameBytes`, () => {
    it(`compares two readings by their bytes`, async () => {
        expect(await sameBytes(new Blob([`abc`]), new Blob([`abc`]))).toBe(true);
        expect(await sameBytes(new Blob([`abc`]), new Blob([`abd`]))).toBe(false);
        expect(await sameBytes(new Blob([`abc`]), new Blob([`abcd`]))).toBe(false);
    });
});

describe(`viewerRefresh`, () => {
    type Held = { readonly blob: Blob };
    const setup = (readings: ViewerReading<Held>[]) => {
        const drawn: string[] = [];
        const gone: string[] = [];
        const settled: (() => void)[] = [];
        let held: Held | undefined = { blob: new Blob([`v1`]) };
        const refresh = viewerRefresh<Held>({
            read: async () => readings.shift() ?? { kind: `failed` },
            held: () => held,
            body: (content) => content.blob,
            adopt: (content) => {
                held = content;
                void content.blob.text().then((text) => drawn.push(text));
            },
            latest: () => () => true,
            gone: (path) => gone.push(path),
            stillOn: () => true,
            settle: (read) => settled.push(read),
        });
        return { refresh, drawn, gone, settled };
    };

    it(`hands the viewer new bytes, and reads once more when the writes settle`, async () => {
        const { refresh, drawn, settled } = setup([
            { kind: `read`, content: { blob: new Blob([`v2`]) } },
            { kind: `read`, content: { blob: new Blob([`v3`]) } },
        ]);
        refresh(`report.docx`);
        await flush();
        expect(drawn).toEqual([`v2`]);
        expect(settled).toHaveLength(1);
        settled[0]!();
        await flush();
        expect(drawn).toEqual([`v2`, `v3`]);
        // The settled read sets no further wait of its own.
        expect(settled).toHaveLength(1);
    });

    it(`redraws nothing for a reading that holds the bytes already drawn`, async () => {
        const { refresh, drawn } = setup([{ kind: `read`, content: { blob: new Blob([`v1`]) } }]);
        refresh(`report.docx`);
        await flush();
        expect(drawn).toEqual([]);
    });

    it(`calls a file gone only when the settled read finds it missing too`, async () => {
        const { refresh, gone, settled } = setup([{ kind: `missing` }, { kind: `missing` }]);
        refresh(`report.docx`);
        await flush();
        expect(gone).toEqual([]);
        settled[0]!();
        await flush();
        expect(gone).toEqual([`report.docx`]);
    });
});
