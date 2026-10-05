import { formatStamp, isOwnerId, ownershipOf, parseStamp } from "./stamp.js";

test("a stamp without an owner keeps the legacy form, and one with an owner puts the owner first", () => {
    expect(formatStamp("cf-app")).toBe("intentic.id=cf-app");
    expect(formatStamp("cf-app", "3f9a1c2b7d4e")).toBe("intentic.owner=3f9a1c2b7d4e intentic.id=cf-app");
});

test("parseStamp reads both forms back, and nothing else", () => {
    expect(parseStamp("intentic.id=cf-app")).toEqual({ id: "cf-app" });
    expect(parseStamp(formatStamp("cf-app", "3f9a1c2b7d4e"))).toEqual({ id: "cf-app", owner: "3f9a1c2b7d4e" });
    // A comment a person wrote, or an empty id, is not a stamp.
    expect(parseStamp("points at the old box")).toBeUndefined();
    expect(parseStamp("intentic.id=")).toBeUndefined();
    expect(parseStamp("intentic.owner=abc")).toBeUndefined();
});

// The point of the owned form: a CLI from before owners lists comments STARTING with `intentic.id=`, so an owned
// record never shows up in its scan as an orphan to prune.
test("an owned stamp does not start with the legacy prefix", () => {
    expect(formatStamp("cf-app", "3f9a1c2b7d4e").startsWith("intentic.id=")).toBe(false);
});

test("ownershipOf answers mine, theirs or unowned", () => {
    expect(ownershipOf("aaa", "aaa")).toBe("mine");
    expect(ownershipOf("bbb", "aaa")).toBe("theirs");
    expect(ownershipOf(undefined, "aaa")).toBe("unowned");
    expect(ownershipOf("", "aaa")).toBe("unowned");
    // With no owner of our own, nothing stamped can be claimed.
    expect(ownershipOf("aaa", undefined)).toBe("theirs");
    expect(ownershipOf(undefined, undefined)).toBe("unowned");
});

test("an owner id is one lowercase word short enough for a DNS comment", () => {
    expect(isOwnerId("3f9a1c2b7d4e")).toBe(true);
    expect(isOwnerId("shop-prod")).toBe(true);
    expect(isOwnerId("")).toBe(false);
    expect(isOwnerId("Has Space")).toBe(false);
    expect(isOwnerId("a".repeat(41))).toBe(false);
});
