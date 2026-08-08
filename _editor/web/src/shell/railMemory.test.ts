// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { type RailSeat, useRailMemory } from "./railMemory";

// The environment read this module's import chain reaches (via useSandbox) at module eval — the same edge
// daemonRestart.test.ts cuts, and jsdom plus this is the whole of what it wants.
vi.hoisted(() => {
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

/* The rail's memory, exercised through the composable itself rather than a pure helper: the rules worth pinning
 * are both about WHEN it acts — hold a seat until the run is complete, write only when the seats themselves
 * change — and a helper handed the answer would test neither. No sandbox is selected here, so the memory lands
 * under the no-sandbox key. */

const KEY = `intentic.railSeats.local`;

const seat = (id: string): RailSeat => ({ id, to: `/ext/${id}`, label: id, icon: `robot` });
const badged = (id: string, count: number): RailSeat => ({ ...seat(id), badge: { count } }) as RailSeat;

let writes: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    localStorage.clear();
    writes = vi.spyOn(Storage.prototype, `setItem`);
});

afterEach(() => vi.restoreAllMocks());

it(`holds a remembered seat until its tile loads, then hands the seat over`, async () => {
    localStorage.setItem(KEY, JSON.stringify([seat(`agents`), seat(`pipelines`)]));
    const live = ref<readonly RailSeat[]>([seat(`agents`)]);

    const held = useRailMemory(live, ref(false));
    expect(held.value.map((ghost) => ghost.to)).toEqual([`/ext/pipelines`]);

    live.value = [seat(`agents`), seat(`pipelines`)];
    await nextTick();
    expect(held.value).toEqual([]);
});

it(`releases a seat whose tile is not coming back once the rail is complete`, async () => {
    localStorage.setItem(KEY, JSON.stringify([seat(`agents`), seat(`retired`)]));
    const settled = ref(false);

    const held = useRailMemory(ref([seat(`agents`)]), settled);
    expect(held.value).toHaveLength(1);

    settled.value = true;
    await nextTick();
    expect(held.value).toEqual([]);
});

it(`holds nothing on a first-ever visit`, () => {
    expect(useRailMemory(ref([seat(`agents`)]), ref(false)).value).toEqual([]);
});

it(`records the completed rail without its badges`, () => {
    useRailMemory(ref([badged(`agents`, 3)]), ref(true));

    expect(JSON.parse(localStorage.getItem(KEY) ?? `[]`)).toEqual([{ id: `agents`, to: `/ext/agents`, label: `agents`, icon: `robot` }]);
});

it(`rewrites only when the seats themselves change`, async () => {
    const live = ref<readonly RailSeat[]>([badged(`agents`, 3)]);
    useRailMemory(live, ref(true));
    expect(writes).toHaveBeenCalledTimes(1);

    // A poll landing a new count re-runs the live rail several times a minute — same seats, so nothing is written.
    live.value = [badged(`agents`, 4)];
    await nextTick();
    expect(writes).toHaveBeenCalledTimes(1);

    live.value = [seat(`agents`), seat(`pipelines`)];
    await nextTick();
    expect(writes).toHaveBeenCalledTimes(2);
});

it(`never overwrites the memory before the rail is complete`, async () => {
    localStorage.setItem(KEY, JSON.stringify([seat(`agents`), seat(`pipelines`)]));
    writes.mockClear();

    useRailMemory(ref([seat(`agents`)]), ref(false));
    await nextTick();
    expect(writes).not.toHaveBeenCalled();
});

it(`treats a memory it cannot read as no memory`, () => {
    localStorage.setItem(KEY, `{ not json`);
    expect(useRailMemory(ref([]), ref(false)).value).toEqual([]);

    localStorage.setItem(KEY, JSON.stringify([{ id: `agents` }]));
    expect(useRailMemory(ref([]), ref(false)).value).toEqual([]);
});
