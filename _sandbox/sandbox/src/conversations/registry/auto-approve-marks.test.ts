import { autoApproveMarks } from "./auto-approve-marks.js";

// The marks as cards wear them: read once, again on every grant write, and again on demand; a read that moved nothing
// publishes nothing, and one that failed keeps the marks last read.

const identities = new Map<string, { readonly startedBy?: string }>([
    ["parent", {}],
    ["child", { startedBy: "agent:parent" }],
]);
const entryOf = (id: string) => {
    const identity = identities.get(id);
    return identity === undefined ? undefined : { identity };
};

test("follows the grants: a mark reaches the conversations started under it, and only a moved read publishes", async () => {
    let marked: ReadonlySet<string> | undefined = new Set();
    let write = (): void => undefined;
    let published = 0;
    const marks = autoApproveMarks(
        {
            marked: async () => marked,
            onChange: (listener) => {
                write = listener;
                return () => undefined;
            },
        },
        entryOf,
        () => (published += 1),
    );
    await marks.follow();
    expect(marks.of({ id: "child" })).toBeUndefined();
    expect(published).toBe(0);

    marked = new Set(["parent"]);
    await marks.reload();
    expect([marks.of({ id: "parent" }), marks.of({ id: "child" })]).toEqual(["own", "inherited"]);
    expect(published).toBe(1);

    // The same marks read again are no news, and a grants file that could not be read keeps the cards as they were.
    await marks.reload();
    marked = undefined;
    write();
    await Promise.resolve();
    expect(published).toBe(1);
    expect(marks.of({ id: "parent" })).toBe("own");
});
