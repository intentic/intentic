import { keepWatchers } from "./signInWatchers";

// What a sign-in's poll does with the attempt's word on who still watches its landing (signInWatchers.ts).

const ROG = { kind: `device`, label: `rog` } as const;
const BRAVE = { kind: `browser`, label: `Brave on Windows` } as const;
type Watcher = typeof ROG | typeof BRAVE;
interface Flow {
    readonly handshake: string;
    readonly catchers: readonly Watcher[];
}
interface FlowRef {
    value: Flow | undefined;
}
const flowOf = (catchers: readonly Watcher[]): FlowRef => ({ value: { handshake: `h1`, catchers } });

test(`a watcher the attempt no longer names leaves the panel's list, so it stops promising a finish by itself`, () => {
    const flow = flowOf([ROG, BRAVE]);
    keepWatchers([BRAVE], flow, (live) => live.handshake === `h1`);
    expect(flow.value?.catchers).toEqual([BRAVE]);
    keepWatchers([], flow, (live) => live.handshake === `h1`);
    expect(flow.value?.catchers).toEqual([]);
});

test(`a daemon that says nothing, another attempt's poll, or a list that still holds leaves the flow as it is`, () => {
    const flow = flowOf([ROG]);
    const before = flow.value;
    keepWatchers(undefined, flow, () => true);
    keepWatchers([], flow, (live) => live.handshake === `another`);
    keepWatchers([ROG], flow, () => true);
    expect(flow.value).toBe(before);
});

test(`a watcher only ever leaves: one the attempt names that the panel never promised is not added`, () => {
    const flow = flowOf([ROG]);
    keepWatchers([ROG, BRAVE], flow, () => true);
    expect(flow.value?.catchers).toEqual([ROG]);
});
