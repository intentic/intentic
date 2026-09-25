import { createPathLists } from "./expiry.js";

// Pins that the kept weight equals a fresh walk after any mix of writes, replacements and deletes.

const walked = (lists: readonly (readonly string[])[]): number => lists.flat().reduce((total, path) => total + path.length, 0);

test("the weight follows inserts, replacements and deletes without walking", () => {
    const lists = createPathLists();
    lists.set("a", ["src/a.ts", "src/b.ts"]);
    lists.set("b", ["README.md"]);
    expect(lists.weight()).toBe(walked([["src/a.ts", "src/b.ts"], ["README.md"]]));

    lists.set("a", ["x"]);
    expect(lists.weight()).toBe(walked([["x"], ["README.md"]]));

    lists.delete("b");
    lists.delete("missing");
    expect(lists.weight()).toBe(1);
    expect(lists.size()).toBe(1);
    expect(lists.get("a")).toEqual(["x"]);

    lists.delete("a");
    expect(lists.weight()).toBe(0);
    expect(lists.size()).toBe(0);
});
