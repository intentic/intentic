import { unstubbed } from "@intentic/testing";
import type { AccountUsage } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { Services } from "../../composition.js";
import { cursorAccountDoor } from "./cursor-accounts.js";

/* Two Cursor accounts look identical until one of them has been refused something; carrying that reading onto the row
   is the whole of what a picker has to tell them apart by. */

const NOW = 1_700_000_000_000;

const spent = (label: string): AccountUsage => ({
    windows: [{ kind: `observed:composer-2.5`, label, utilization: 100, gates: { models: [`composer-2.5`] } }],
    measuredAt: NOW,
});

const door = (stored: Record<string, AccountUsage>, refresh = vi.fn(async () => undefined)) => {
    const services = unstubbed<Services>(`services`, {
        cursorStore: unstubbed<Services[`cursorStore`]>(`cursorStore`, {
            list: async () => [
                { id: `one`, label: `Cursor`, connectedAt: 0 },
                { id: `two`, label: `Cursor`, connectedAt: 1 },
            ],
        }),
        accountUsage: unstubbed<Services[`accountUsage`]>(`accountUsage`, { read: async () => stored }),
        headroom: unstubbed<Services[`headroom`]>(`headroom`, { refresh }),
    });
    return { refresh, list: cursorAccountDoor(services).list };
};

test("the account that was refused a model carries the reading, and the one that was not carries none", async () => {
    const { list } = door({ one: spent(`Composer 2.5`) });

    const rows = await list(false);
    expect(rows.map((row) => row.id)).toEqual([`one`, `two`]);
    expect(rows[0]?.usage).toEqual(spent(`Composer 2.5`));
    expect(rows[1]?.usage).toBeUndefined();
});

// The store drops a reading that has aged out, so the sweep is the only thing that can take one off a row.
test("rows are swept before they are listed, and a press sweeps past the read budget", async () => {
    const { refresh, list } = door({});

    await list(false);
    expect(refresh).toHaveBeenLastCalledWith({ scope: { providers: [`cursor`] } });

    await list(true);
    expect(refresh).toHaveBeenLastCalledWith({ scope: { providers: [`cursor`] }, maxAgeMs: 0, watched: true });
});
