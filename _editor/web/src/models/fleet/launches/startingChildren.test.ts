// Which spawned children are still on their way to the fleet (startingIds): the roster files a child the moment its
// parent asks for it, the fleet only once its first turn begins, and the tray stands in for it until then.
import { startingIds } from "./startingChildren";

const rows = (...ids: string[]): { readonly id: string }[] => ids.map((id) => ({ id }));

it(`names a live spawned child the fleet does not hold yet, and lets it go once the fleet holds it`, () => {
    expect([...startingIds(rows(`held`, `begun`), () => [], undefined)]).toEqual([`held`, `begun`]);
    expect([...startingIds(rows(`held`, `begun`), () => rows(`begun`), undefined)]).toEqual([`held`]);
});

it(`keeps the same set while its members stand still, and reads no fleet when no spawned child is live`, () => {
    const first = startingIds(rows(`held`), () => rows(`other`), undefined);

    // A fleet tick that moved none of them: the same set, so no tray wakes for it.
    expect(startingIds(rows(`held`), () => rows(`other`, `another`), first)).toBe(first);
    expect(startingIds(rows(`held`, `next`), () => [], first)).not.toBe(first);

    const fleet = jest.fn(() => []);
    const none = startingIds([], fleet, first);
    expect(none.size).toBe(0);
    expect(fleet).not.toHaveBeenCalled();
    expect(startingIds([], fleet, none)).toBe(none);
});
