import "@intentic/testing/dom";
import { nextTick, ref } from "vue";
import { type RailTile, useRailMemory } from "./railMemory";

// The environment read this module's import chain reaches (via useSandbox) at module eval: the same edge
// daemonRestart.test.ts cuts, and jsdom plus this is the whole of what it wants.

/* The rail's memory, exercised through the composable itself rather than a pure helper: the rules worth pinning are both about WHEN it acts. */

const KEY = `intentic.railTiles.local`;

const tile = (id: string): RailTile => ({ id, to: `/ext/${id}`, label: id, icon: `robot` });
const badged = (id: string, count: number): RailTile => ({ ...tile(id), badge: { count } }) as RailTile;

let writes: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
    localStorage.clear();
    writes = jest.spyOn(Storage.prototype, `setItem`);
});

afterEach(() => jest.restoreAllMocks());

it(`holds a remembered tile until its tile loads, then hands the tile over`, async () => {
    localStorage.setItem(KEY, JSON.stringify([tile(`agents`), tile(`pipelines`)]));
    const live = ref<readonly RailTile[]>([tile(`agents`)]);

    const held = useRailMemory(live, ref(false));
    expect(held.value.map((ghost) => ghost.to)).toEqual([`/ext/pipelines`]);

    live.value = [tile(`agents`), tile(`pipelines`)];
    await nextTick();
    expect(held.value).toEqual([]);
});

it(`releases a tile whose tile is not coming back once the rail is complete`, async () => {
    localStorage.setItem(KEY, JSON.stringify([tile(`agents`), tile(`retired`)]));
    const settled = ref(false);

    const held = useRailMemory(ref([tile(`agents`)]), settled);
    expect(held.value).toHaveLength(1);

    settled.value = true;
    await nextTick();
    expect(held.value).toEqual([]);
});

it(`holds nothing on a first-ever visit`, () => {
    expect(useRailMemory(ref([tile(`agents`)]), ref(false)).value).toEqual([]);
});

it(`records the completed rail without its badges`, () => {
    useRailMemory(ref([badged(`agents`, 3)]), ref(true));

    expect(JSON.parse(localStorage.getItem(KEY) ?? `[]`)).toEqual([{ id: `agents`, to: `/ext/agents`, label: `agents`, icon: `robot` }]);
});

it(`rewrites only when the tiles themselves change`, async () => {
    const live = ref<readonly RailTile[]>([badged(`agents`, 3)]);
    useRailMemory(live, ref(true));
    expect(writes).toHaveBeenCalledTimes(1);

    // A poll landing a new count re-runs the live rail several times a minute: same tiles, so nothing is written.
    live.value = [badged(`agents`, 4)];
    await nextTick();
    expect(writes).toHaveBeenCalledTimes(1);

    live.value = [tile(`agents`), tile(`pipelines`)];
    await nextTick();
    expect(writes).toHaveBeenCalledTimes(2);
});

it(`never overwrites the memory before the rail is complete`, async () => {
    localStorage.setItem(KEY, JSON.stringify([tile(`agents`), tile(`pipelines`)]));
    writes.mockClear();

    useRailMemory(ref([tile(`agents`)]), ref(false));
    await nextTick();
    expect(writes).not.toHaveBeenCalled();
});

it(`treats a memory it cannot read as no memory`, () => {
    localStorage.setItem(KEY, `{ not json`);
    expect(useRailMemory(ref([]), ref(false)).value).toEqual([]);

    localStorage.setItem(KEY, JSON.stringify([{ id: `agents` }]));
    expect(useRailMemory(ref([]), ref(false)).value).toEqual([]);
});
