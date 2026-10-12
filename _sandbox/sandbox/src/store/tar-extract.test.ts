import { memberPath } from "./tar-extract.js";

// The one judgement every tar reader makes of a member's name before placing it anywhere.

test("a member's path comes back relative and folded, however the packer spelled it", () => {
    expect(memberPath("a/b/c.txt")).toBe("a/b/c.txt");
    expect(memberPath("./a//b/./c.txt")).toBe("a/b/c.txt");
    expect(memberPath("dir/")).toBe("dir");
    expect(memberPath("./")).toBe("");
});

test("an absolute path or a `..` segment is refused, even one that would fold back inside", () => {
    expect(memberPath("/etc/passwd")).toBeUndefined();
    expect(memberPath("../evil.txt")).toBeUndefined();
    expect(memberPath("a/../../evil.txt")).toBeUndefined();
    expect(memberPath("a/../b.txt")).toBeUndefined();
});
