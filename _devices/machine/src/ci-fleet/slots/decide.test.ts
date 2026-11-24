import { ceilingOf, floorOf, nextWanted, planSlots, SHRINK_AFTER_MS, SLOT_BYTES, targetOf, wantedSlots } from "./decide.js";
import { SlotsConfigSchema } from "./slots-config.js";

/* The holder's decisions: how many slots the sandboxes and the floor come to, that the gate band is never among them,
   that a smaller need waits its two minutes, and which slots are taken and handed back. */

const omen = SlotsConfigSchema.parse({});
const z440 = SlotsConfigSchema.parse({ usable: 9 });

test("the target is the floor and the sandboxes' memory in whole GiBs, rounded up", () => {
    expect(floorOf(omen)).toBe(0);
    expect(floorOf(z440)).toBe(7);
    expect(targetOf(omen, 0)).toBe(0);
    expect(targetOf(omen, 1)).toBe(1);
    expect(targetOf(omen, 3 * SLOT_BYTES)).toBe(3);
    expect(targetOf(omen, 3 * SLOT_BYTES + 1)).toBe(4);
    expect(targetOf(z440, 0)).toBe(7);
    expect(targetOf(z440, 2.5 * SLOT_BYTES)).toBe(10);
});

test("the target never reaches into the gate band, however much the sandboxes use", () => {
    expect(ceilingOf(omen)).toBe(10);
    expect(targetOf(omen, 64 * SLOT_BYTES)).toBe(10);
    expect(targetOf(z440, 5 * SLOT_BYTES)).toBe(10);
    expect(Math.min(...wantedSlots(omen, 99))).toBe(7);
    // A floor past the ceiling (usable below the gate band) is still capped.
    expect(targetOf(SlotsConfigSchema.parse({ usable: 2 }), 0)).toBe(10);
});

test("slots are wanted from the top of the pool down", () => {
    expect(wantedSlots(omen, 3)).toEqual([16, 15, 14]);
    expect(wantedSlots(omen, 0)).toEqual([]);
    expect(wantedSlots(SlotsConfigSchema.parse({ total: 8, reserved: 2 }), 99)).toEqual([8, 7, 6, 5, 4, 3]);
});

test("growing is at once; shrinking waits until the need has stayed lower for two minutes", () => {
    const start = 1_000_000;
    let state = nextWanted({ wanted: 2 }, 5, start);
    expect(state).toEqual({ wanted: 5 });
    state = nextWanted(state, 1, start + 1_000);
    expect(state.wanted).toBe(5);
    state = nextWanted(state, 3, start + 60_000);
    expect(state.wanted).toBe(5);
    state = nextWanted(state, 2, start + 1_000 + SHRINK_AFTER_MS - 1);
    expect(state.wanted).toBe(5);
    // After the window, down to the most it asked for meanwhile, not the last reading.
    state = nextWanted(state, 2, start + 1_000 + SHRINK_AFTER_MS);
    expect(state).toEqual({ wanted: 3 });
});

test("a need that comes back up inside the window cancels the shrink", () => {
    let state = nextWanted({ wanted: 6 }, 1, 0);
    state = nextWanted(state, 6, 30_000);
    expect(state).toEqual({ wanted: 6 });
    state = nextWanted(state, 1, SHRINK_AFTER_MS + 1);
    expect(state.wanted).toBe(6);
});

test("the plan takes what is missing top down and hands back the lowest first", () => {
    expect(planSlots(new Set([16]), [16, 15, 14])).toEqual({ take: [15, 14], release: [] });
    expect(planSlots(new Set([16, 15, 14, 13]), [16, 15])).toEqual({ take: [], release: [13, 14] });
    // A slot CI held at the last look is simply taken now.
    expect(planSlots(new Set([16, 14]), [16, 15, 14])).toEqual({ take: [15], release: [] });
});
