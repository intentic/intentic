import type { EngineMoveEvent, EngineStatus } from "../desktop";
import { barOf, endOf, engineOf, foldMove, gigabytes, keptCopiesOf, moveTargetOf, offerOf, pcEngineOf, startMove, type MoveProgress } from "./engineMove";

// A move between engines as the card reads it: what it offers for where the PC is, how far a move has got from the steps
// ic prints (its engine/moves.rs `say`), how it ended, and the copies it left. The lines are ic's own shapes.

const ON_DOCKER_DESKTOP: EngineStatus = {
    engine: `dockerDesktop`,
    chosen: `dockerDesktop`,
    installed: false,
    running: false,
    version: null,
    active: false,
    held: false,
    distro: `intentic-engine`,
    dockerDesktop: true,
    ownEngine: false,
    preferred: null,
    gpu: false,
    bringYourOwn: false,
    canMove: true,
    offerMove: false,
    moves: null,
};
const ON_OURS: EngineStatus = { ...ON_DOCKER_DESKTOP, engine: `intentic`, chosen: `intentic`, installed: true, running: true, active: true };

const said = (step: string, fields: Record<string, unknown> = {}): EngineMoveEvent => ({ step, ...fields });

describe(`what the card offers`, () => {
    it(`keeps the move in reach on Docker Desktop, and puts it in front of the reader once ic says it is worth making`, () => {
        expect(offerOf(ON_DOCKER_DESKTOP)).toBe(`optIn`);
        expect(offerOf({ ...ON_DOCKER_DESKTOP, offerMove: true })).toBe(`offer`);
        expect(moveTargetOf(ON_DOCKER_DESKTOP)).toBe(`intentic`);
        expect(moveTargetOf({ ...ON_DOCKER_DESKTOP, offerMove: true })).toBe(`intentic`);
    });

    it(`says why there is no move for a sandbox that was handed the GPU, whatever else ic says`, () => {
        const gpu = { ...ON_DOCKER_DESKTOP, gpu: true, canMove: false, offerMove: true };
        expect(offerOf(gpu)).toBe(`gpu`);
        expect(moveTargetOf(gpu)).toBeUndefined();
    });

    it(`offers the way back from Intentic's engine only while Docker Desktop is installed`, () => {
        expect(offerOf(ON_OURS)).toBe(`back`);
        expect(moveTargetOf(ON_OURS)).toBe(`docker-desktop`);
        const alone = { ...ON_OURS, dockerDesktop: false, canMove: false };
        expect(offerOf(alone)).toBe(`none`);
        expect(moveTargetOf(alone)).toBeUndefined();
        expect(offerOf({ ...ON_DOCKER_DESKTOP, engine: `native`, canMove: false })).toBe(`none`);
    });

    it(`names the two engines as ic does, and nothing else`, () => {
        expect(engineOf(`docker-desktop`)).toBe(`dockerDesktop`);
        expect(engineOf(`intentic`)).toBe(`intentic`);
        expect(pcEngineOf(`dockerDesktop`)).toBe(`dockerDesktop`);
        expect(pcEngineOf(`native`)).toBeUndefined();
        expect(pcEngineOf(`docker-desktop`)).toBeUndefined();
        expect(pcEngineOf(3)).toBeUndefined();
    });
});

describe(`a move under way`, () => {
    const fold = (from: MoveProgress, ...events: EngineMoveEvent[]): MoveProgress => events.reduce(foldMove, from);

    it(`follows Intentic's engine being installed first, with its own percent`, () => {
        const installing = fold(startMove(`intentic`, `ours`), said(`engine`, { slug: ``, sentence: `Downloading Intentic's engine`, percent: 40, to: `intentic` }));
        expect(installing.install).toEqual({ sentence: `Downloading Intentic's engine`, percent: 40 });
        expect(barOf(installing)).toBe(40);
        // A sentence with no percent yet: a bar that moves on its own.
        expect(barOf(fold(installing, said(`engine`, { slug: ``, sentence: `Starting it`, percent: null })))).toBeUndefined();
    });

    it(`goes sandbox by sandbox, each step in turn, the install over once the first begins`, () => {
        const begun = fold(
            startMove(`intentic`, `ours`),
            said(`engine`, { slug: ``, sentence: `Starting it`, percent: 100 }),
            said(`begin`, { slug: `work`, index: 0, count: 2, bytes: 3_000_000_000 }),
        );
        expect(begun).toEqual({ source: `ours`, to: `intentic`, slug: `work`, index: 0, count: 2, step: `begin`, moved: 0 });
        expect(barOf(begun)).toBeUndefined();

        const stopping = fold(begun, said(`stopping`, { slug: `work`, container: `intentic-sandbox-work` }));
        expect(stopping.step).toBe(`stopping`);

        // The image's size is ic's estimate: the bytes are said, the bar does not pretend to know how far it is.
        const image = fold(stopping, said(`image`, { slug: `work`, images: [`ghcr.io/intentic/sandbox:stable`] }));
        expect(image).toMatchObject({ step: `image`, done: 0 });
        expect(image.total).toBeUndefined();
        const imaging = fold(image, said(`image`, { slug: `work`, done: 500_000_000, total: 1_000_000_000 }));
        expect(imaging).toMatchObject({ step: `image`, done: 500_000_000, total: 1_000_000_000 });
        expect(barOf(imaging)).toBeUndefined();

        // A volume's files are counted exactly: the bar fills.
        const volume = fold(imaging, said(`volume`, { slug: `work`, volume: `work-data`, total: 2_000_000_000 }));
        expect(volume).toMatchObject({ step: `volume`, done: 0, total: 2_000_000_000 });
        expect(barOf(volume)).toBe(0);
        const copying = fold(volume, said(`volume`, { slug: `work`, done: 1_500_000_000, total: 2_000_000_000 }));
        expect(barOf(copying)).toBe(75);

        const starting = fold(copying, said(`starting`, { slug: `work` }));
        expect(starting.step).toBe(`starting`);
        expect(starting.done).toBeUndefined();
        expect(starting.total).toBeUndefined();

        const moved = fold(starting, said(`moved`, { slug: `work` }));
        expect(moved).toMatchObject({ step: `moved`, moved: 1, index: 0, count: 2 });

        const second = fold(moved, said(`begin`, { slug: `notes`, index: 1, count: 2, bytes: 10 }));
        expect(second).toEqual({ source: `ours`, to: `intentic`, slug: `notes`, index: 1, count: 2, step: `begin`, moved: 1 });
    });

    it(`learns where a move goes and which sandbox it is on from a window that joined part way`, () => {
        const joined = fold(startMove(undefined, `heard`), said(`volume`, { slug: `notes`, done: 10, total: 40, to: `dockerDesktop` }));
        expect(joined).toEqual({ source: `heard`, to: `dockerDesktop`, slug: `notes`, step: `volume`, done: 10, total: 40, moved: 0 });
        // Which of how many it was is not known for a sandbox that was not begun in this window's hearing.
        const known = fold(startMove(`intentic`, `heard`), said(`begin`, { slug: `work`, index: 0, count: 2 }), said(`stopping`, { slug: `notes` }));
        expect(known.index).toBeUndefined();
        expect(known.count).toBe(2);
        expect(known.slug).toBe(`notes`);
    });

    it(`passes over what it does not read: its ending, steps it does not know, fields of the wrong kind`, () => {
        const begun = fold(startMove(`intentic`, `ours`), said(`begin`, { slug: `work`, index: 0, count: 1 }));
        expect(fold(begun, said(`done`, { slug: ``, engine: `intentic`, count: 1 }))).toEqual(begun);
        expect(fold(begun, said(`failed`, { slug: ``, reason: `no` }))).toEqual(begun);
        expect(fold(begun, said(`rewound`, { slug: `work` }))).toEqual(begun);
        expect(fold(begun, said(`engine`, { slug: ``, percent: 5 }))).toEqual(begun);
        const odd = fold(begun, said(`volume`, { slug: `work`, done: `lots`, total: -1 }));
        expect(odd).toMatchObject({ step: `volume`, done: 0 });
        expect(odd.total).toBeUndefined();
        expect(barOf(fold(begun, said(`volume`, { slug: `work`, done: 9, total: 4 })))).toBe(100);
    });
});

describe(`how a move ended`, () => {
    it(`is read from its exit step, as the app wrote it`, () => {
        expect(
            endOf(said(`exit`, { outcome: `failed`, code: 1, putBack: true, ran: true, engine: null, count: null, reason: `work: no room`, log: `C:\\logs\\m.log` })),
        ).toEqual({ outcome: `failed`, code: 1, putBack: true, ran: true, engine: null, count: null, reason: `work: no room`, log: `C:\\logs\\m.log` });
        expect(endOf(said(`exit`, { outcome: `moved`, code: 0, putBack: false, engine: `intentic`, count: 2 }))).toMatchObject({
            outcome: `moved`,
            engine: `intentic`,
            count: 2,
            ran: true,
            reason: null,
        });
    });

    it(`is nothing for any other step, or an outcome the card has no words for`, () => {
        expect(endOf(said(`done`, { outcome: `moved` }))).toBeUndefined();
        expect(endOf(said(`exit`, { outcome: `halfway` }))).toBeUndefined();
        expect(endOf(said(`exit`))).toBeUndefined();
    });
});

describe(`the copies a move left`, () => {
    it(`are said once for each engine that keeps some, until the day the last of them goes`, () => {
        const status: EngineStatus = {
            ...ON_OURS,
            moves: {
                moving: false,
                to: null,
                last: { from: `dockerDesktop`, to: `intentic`, at: 1 },
                leftBehind: [
                    { slug: `work`, on: `dockerDesktop`, removeAfter: 1_000 },
                    { slug: `notes`, on: `dockerDesktop`, removeAfter: 3_000 },
                    { slug: `old`, on: `intentic`, removeAfter: 2_000 },
                    { slug: `odd`, on: `native`, removeAfter: 9_000 },
                ],
            },
        };
        expect(keptCopiesOf(status)).toEqual([
            { on: `dockerDesktop`, until: 3_000, count: 2 },
            { on: `intentic`, until: 2_000, count: 1 },
        ]);
        expect(keptCopiesOf(ON_OURS)).toEqual([]);
        expect(keptCopiesOf({ ...ON_OURS, moves: undefined })).toEqual([]);
        expect(keptCopiesOf(undefined)).toEqual([]);
    });
});

it(`says bytes as ic does, in decimal gigabytes to one place, and small volumes in megabytes`, () => {
    expect(gigabytes(1_234_567_890)).toBe(`1.2 GB`);
    expect(gigabytes(0)).toBe(`0 MB`);
    expect(gigabytes(29_458_217)).toBe(`29 MB`);
    expect(gigabytes(100_000_000)).toBe(`0.1 GB`);
    expect(gigabytes(15_960_000_000)).toBe(`16.0 GB`);
});
