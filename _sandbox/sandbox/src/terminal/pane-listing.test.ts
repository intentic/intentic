import { createPaneListing } from "./pane-listing.js";

// The listing two timed readers share: one tmux run serves both within a second, a reader that must see the present
// always lists, and a change the daemon made is never answered by a listing from before it.

const counting = () => {
    let runs = 0;
    let clock = 0;
    const listing = createPaneListing(
        async () => {
            runs += 1;
            return { stdout: `run ${String(runs)}\n` };
        },
        () => clock,
    );
    return { listing, runs: () => runs, advance: (ms: number) => (clock += ms) };
};

test(`a timed reader takes a listing begun within its age, and lists again past it`, async () => {
    const { listing, runs, advance } = counting();
    expect((await listing.recent(1000)).stdout).toBe("run 1\n");
    advance(900);
    expect((await listing.recent(1000)).stdout).toBe("run 1\n");
    expect(runs()).toBe(1);
    advance(200);
    expect((await listing.recent(1000)).stdout).toBe("run 2\n");
    expect(runs()).toBe(2);
});

test(`readers asking together share the listing in flight`, async () => {
    const { listing, runs } = counting();
    const both = await Promise.all([listing.recent(1000), listing.recent(1000)]);
    expect(both.map((answer) => answer.stdout)).toEqual(["run 1\n", "run 1\n"]);
    expect(runs()).toBe(1);
});

test(`a fresh read always lists, and what it read serves the next timed reader`, async () => {
    const { listing, runs } = counting();
    await listing.fresh();
    await listing.fresh();
    expect(runs()).toBe(2);
    expect((await listing.recent(1000)).stdout).toBe("run 2\n");
    expect(runs()).toBe(2);
});

test(`after a change the daemon made, no earlier listing is handed out, even one still in flight`, async () => {
    let release: ((value: { stdout: string }) => void) | undefined;
    let runs = 0;
    const listing = createPaneListing(
        () =>
            new Promise((resolve) => {
                runs += 1;
                if (runs === 1) {
                    release = resolve;
                } else {
                    resolve({ stdout: "after\n" });
                }
            }),
        () => 0,
    );
    const before = listing.recent(1000);
    listing.changed();
    release?.({ stdout: "before\n" });
    expect((await before).stdout).toBe("before\n");
    expect((await listing.recent(1000)).stdout).toBe("after\n");
    expect(runs).toBe(2);
});

test(`a failed listing is not kept`, async () => {
    let runs = 0;
    const listing = createPaneListing(async () => {
        runs += 1;
        if (runs === 1) {
            throw new Error("no server");
        }
        return { stdout: "up\n" };
    });
    await expect(listing.recent(1000)).rejects.toThrow("no server");
    expect((await listing.recent(1000)).stdout).toBe("up\n");
});
