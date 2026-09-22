// The stage is read off a BOUNDED tail, so every case here is a window onto the middle of a build: never the first
// line, and often with the previous stage's last lines still in it.
import { it, expect } from "bun:test";
import { readRebuildProgress, rebuildFraction, stageStart } from "./devRebuildStages";

it(`reads turbo's task prefix as the compile, naming the package it is on`, () => {
    const read = readRebuildProgress([
        `@intentic/share-view:build: ✓ built in 1.40s`,
        `@intentic/sandbox:build: cache miss, executing 8848311d2133c319`,
    ]);

    expect(read).toEqual({ stage: `compile`, detail: `@intentic/sandbox`, layers: undefined });
});

it(`reads BuildKit's step counter as the image being built`, () => {
    const read = readRebuildProgress([`#12 [builder 4/9] RUN pnpm install`, `#12 DONE 3.4s`]);

    expect(read?.stage).toBe(`image`);
    expect(read?.layers).toEqual({ done: 4, total: 9 });
});

it(`moves off the compile the moment the prepare script says the trees are ready`, () => {
    const read = readRebuildProgress([`@intentic/cli:build: done`, `image trees ready in .image-out/`]);

    expect(read?.stage).toBe(`image`);
});

it(`reads ic's own narration as the swap, whatever the docker lines above it said`, () => {
    const read = readRebuildProgress([
        `#24 exporting layers`,
        `#24 naming to docker.io/library/intentic-sandbox:dev`,
        `intentic: [recreate] starting the container`,
    ]);

    expect(read).toEqual({ stage: `swap`, detail: `[recreate] starting the container`, layers: undefined });
});

// The swap's own recreate rebuilds the approved overlay, which is a second docker build. A tail holding both must not
// read as the image stage coming round again.
it(`stays on the swap when the recreate's own docker build prints after it`, () => {
    const read = readRebuildProgress([`intentic: [recreate] re-basing the overlay`, `#3 [stage-1 2/4] RUN apt-get install -y ripgrep`]);

    expect(read?.stage).toBe(`swap`);
});

it(`keeps the newest layer count inside one stage`, () => {
    const read = readRebuildProgress([`#4 [builder 2/9] COPY . .`, `#9 [builder 7/9] RUN cargo build`]);

    expect(read?.layers).toEqual({ done: 7, total: 9 });
});

it(`reports nothing for a tail with nothing recognisable in it`, () => {
    expect(readRebuildProgress([`warning: unused variable`, ``])).toBeUndefined();
});

it(`ignores a step counter whose numbers make no sense`, () => {
    const read = readRebuildProgress([`#7 [builder 9/0] RUN true`]);

    expect(read?.stage).toBe(`image`);
    expect(read?.layers).toBeUndefined();
});

it(`counts a finished stage in full and docker's layers inside the running one`, () => {
    const compile = rebuildFraction({ stage: `compile`, detail: undefined, layers: undefined });
    const halfway = rebuildFraction({ stage: `image`, detail: undefined, layers: { done: 5, total: 10 } });
    const swap = rebuildFraction({ stage: `swap`, detail: undefined, layers: undefined });

    expect(compile).toBe(0);
    expect(halfway).toBeCloseTo(stageStart(`image`) + 0.3, 5);
    expect(swap).toBeCloseTo(0.9, 5);
    expect(rebuildFraction({ stage: `image`, detail: undefined, layers: { done: 10, total: 10 } })).toBeCloseTo(0.9, 5);
});
