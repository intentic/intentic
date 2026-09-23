import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type EffectScope, effectScope, nextTick, ref, shallowRef } from "vue";
import { ARCHIVE_PAGE, type BoardView, stepView, VIEW_START, type ViewEvent } from "./boardView";
import { useArchiveDoor } from "./archiveDoor";

// Pins the archive's door and what the board says about it: each opening re-reads the pile at one page, emptying it
// closes the dialog at once and says what went once the daemon answers, and every archive pulses the counter and tells a
// screen reader, the pulse restarting on each one.

const running: EffectScope[] = [];
afterEach(() => {
    for (const effects of running.splice(0)) {
        effects.stop();
    }
    jest.useRealTimers();
});

const doorOf = () => {
    const view = shallowRef<BoardView>(VIEW_START);
    const move = (event: ViewEvent): void => {
        view.value = stepView(view.value, event);
    };
    const archived = shallowRef<readonly unknown[]>([`a`, `b`, `c`]);
    const deletes: { settle: () => void; refuse: (error: Error) => void }[] = [];
    const agents = {
        archived,
        loadArchived: jest.fn(async () => undefined),
        purgeArchived: jest.fn(
            () =>
                new Promise<void>((resolve, reject) => {
                    deletes.push({ settle: resolve, refuse: reject });
                }),
        ),
        archivedFlash: ref(0),
        undoable: shallowRef<readonly string[]>([]),
    };
    const effects = effectScope();
    running.push(effects);
    const door = effects.run(() => useArchiveDoor({ view, move, agents }))!;
    return { view, agents, door, deletes };
};

describe(`the archive's door`, () => {
    it(`re-reads the pile at every opening, one page deep, and reads nothing on the way out`, async () => {
        const { view, agents, door } = doorOf();
        view.value = { ...VIEW_START, shown: 90, purged: true };

        await door.toggleArchive();
        expect(view.value).toEqual({ ...VIEW_START, archive: true, shown: ARCHIVE_PAGE });
        await door.toggleArchive();
        expect(view.value).toEqual(VIEW_START);
        await door.toggleArchive();

        expect(agents.loadArchived).toHaveBeenCalledTimes(2);
    });
});

describe(`emptying the archive`, () => {
    it(`closes the dialog at once, holds the button while the daemon deletes, then says how many went`, async () => {
        const { view, agents, door, deletes } = doorOf();
        view.value = { ...VIEW_START, archive: true };
        door.pendingPurge.value = true;

        const purge = door.confirmPurge();
        expect([door.pendingPurge.value, door.purging.value]).toEqual([false, true]);

        agents.archived.value = [`c`];
        deletes[0]!.settle();
        await purge;

        expect(door.purging.value).toBe(false);
        expect(view.value.purged).toBe(true);
        expect(door.announcement.value).toBe(`2 archived agents deleted`);
    });

    it(`lets a failure through, marking nothing emptied and saying nothing`, async () => {
        const { view, door, deletes } = doorOf();
        view.value = { ...VIEW_START, archive: true };

        const purge = door.confirmPurge();
        deletes[0]!.refuse(new Error(`the daemon went away`));

        await expect(purge).rejects.toThrow(`the daemon went away`);
        expect([door.purging.value, view.value.purged, door.announcement.value]).toEqual([false, false, ``]);
    });
});

describe(`saying that an archive happened`, () => {
    it(`pulses the counter for a beat and tells a screen reader how many the undo would put back`, async () => {
        jest.useFakeTimers();
        const { agents, door } = doorOf();

        agents.undoable.value = [`a1`];
        agents.archivedFlash.value += 1;
        await nextTick();
        expect([door.pulsing.value, door.announcement.value]).toEqual([true, `1 agent archived`]);

        await advanceTimersByTimeAsync(1_000);
        agents.undoable.value = [`a1`, `a2`];
        agents.archivedFlash.value += 1;
        await nextTick();
        expect(door.announcement.value).toBe(`2 agents archived`);

        // The second archive restarted the beat: the first one's would have ended by now.
        await advanceTimersByTimeAsync(1_099);
        expect(door.pulsing.value).toBe(true);
        await advanceTimersByTimeAsync(1);
        expect(door.pulsing.value).toBe(false);
    });
});
