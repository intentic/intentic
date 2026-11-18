import { commandPolicyLine, commandPolicyLines, memoryOwnerGrants } from "./owner-grants.js";

// The owner's yeses that name no conversation. One kind is kept here, a command policy line allowed with Always: it is
// listed oldest first (the order the judge reads it in), allowed once however it is spelled, and taken back by its text.

test("lines are kept oldest first, with who allowed them, and a repeat of one that stands is no news", async () => {
    let clock = 100;
    const grants = memoryOwnerGrants(() => clock);
    const heard: string[] = [];
    grants.onChange(() => heard.push("changed"));

    expect(await grants.allowCommandPolicy("Deleting build directories under /work is fine.", "ada@acme.dev")).toBe(true);
    clock = 200;
    expect(await grants.allowCommandPolicy("Pushing to a scratch branch is fine.", undefined)).toBe(true);
    expect(await grants.allowCommandPolicy("Deleting build directories under /work is fine.", "bob@acme.dev")).toBe(false);

    expect(await grants.read()).toEqual({
        commandPolicy: [
            { line: "Deleting build directories under /work is fine.", at: 100, by: "ada@acme.dev" },
            { line: "Pushing to a scratch branch is fine.", at: 200 },
        ],
        unreadable: false,
    });
    expect(heard).toEqual(["changed", "changed"]);
});

test("a line is one line of prose: wrapped, padded or hiding a control character, it is the same grant", async () => {
    const grants = memoryOwnerGrants(() => 1);
    await grants.allowCommandPolicy("  Deleting build\n   directories under /work\tis fine.  ", undefined);
    expect(await grants.allowCommandPolicy("Deleting build directories under /work is fine.", undefined)).toBe(false);
    expect((await grants.read()).commandPolicy.map((grant) => grant.line)).toEqual(["Deleting build directories under /work is fine."]);
    // Text that says nothing is no grant.
    expect(await grants.allowCommandPolicy("  \n ", undefined)).toBe(false);
    expect(commandPolicyLine("a‮b")).toBe("ab");
});

test("taking one back leaves the rest and says whether there was one, however the caller spelled it", async () => {
    const grants = memoryOwnerGrants(() => 1);
    const heard: string[] = [];
    await grants.allowCommandPolicy("First.", undefined);
    await grants.allowCommandPolicy("Second.", undefined);
    grants.onChange(() => heard.push("changed"));

    expect(await grants.revokeCommandPolicy("  First.\n")).toBe(true);
    expect(await grants.revokeCommandPolicy("First.")).toBe(false);
    expect((await grants.read()).commandPolicy.map((grant) => grant.line)).toEqual(["Second."]);
    expect(heard).toEqual(["changed"]);
});

test("a listener that throws neither fails the write nor keeps the others from hearing it", async () => {
    const grants = memoryOwnerGrants(() => 1);
    const heard: string[] = [];
    grants.onChange(() => {
        throw new Error("a broken view");
    });
    const stop = grants.onChange(() => heard.push("changed"));
    await grants.allowCommandPolicy("First.", undefined);
    stop();
    await grants.allowCommandPolicy("Second.", undefined);
    expect(heard).toEqual(["changed"]);
});

// What the judge reads: the lines alone, in order. A file this build cannot read grants nothing and is said out loud.
test("the judge's lines are the stored ones in order, and an unreadable record contributes none and warns", async () => {
    const grants = memoryOwnerGrants(() => 1);
    await grants.allowCommandPolicy("First.", undefined);
    await grants.allowCommandPolicy("Second.", undefined);
    const warned: string[] = [];
    expect(await commandPolicyLines(grants, (message) => warned.push(message))()).toEqual(["First.", "Second."]);
    expect(warned).toEqual([]);

    const unreadable = { read: async () => ({ commandPolicy: [], unreadable: true }) };
    expect(await commandPolicyLines(unreadable, (message) => warned.push(message))()).toEqual([]);
    expect(warned).toEqual(["owner grants: owner-grants.json could not be read, so the lines allowed with Always are not in the safety policy until it is fixed"]);
});
