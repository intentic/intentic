import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { assertPath, assertScope, rootsOf, ScopeError, withinRoots } from "./policy.js";

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    sandboxRemove: "on",
    destructive: "on",
    ...overrides,
});

test("no declared roots means the home directory, which is what the card promises", () => {
    expect(rootsOf(scopes())).toEqual([resolve(homedir())]);
});

test("roots are one per line, absolute, with ~ expanded and blanks ignored", () => {
    const roots = rootsOf(scopes({ roots: `/srv/app\n\n  ~/projects  \nnot-absolute` }));
    expect(roots).toEqual([resolve("/srv/app"), resolve(join(homedir(), "projects"))]);
});

test("a sibling directory sharing a prefix is NOT inside the root", () => {
    // The trap a naive startsWith falls into: /home/meeting is not under /home/me.
    expect(withinRoots("/home/meeting/file.txt", ["/home/me"])).toBe(false);
    expect(withinRoots("/home/me/file.txt", ["/home/me"])).toBe(true);
    expect(withinRoots("/home/me", ["/home/me"])).toBe(true);
});

test("traversal is normalized before it is judged", () => {
    expect(withinRoots("/home/me/../../etc/passwd", ["/home/me"])).toBe(false);
    expect(withinRoots("/home/me/projects/../notes.txt", ["/home/me"])).toBe(true);
});

test("a path outside the roots is refused with the roots named, so the user knows what to widen", () => {
    const allowed = scopes({ roots: "/srv/app" });
    expect(() => assertPath("/etc/shadow", allowed, "read")).toThrow(ScopeError);
    expect(() => assertPath("/etc/shadow", allowed, "read")).toThrow(/\/srv\/app/);
    expect(assertPath("/srv/app/config.json", allowed, "read")).toBe(resolve("/srv/app/config.json"));
});

test("each switch refuses by naming the control on the card, not a mechanism", () => {
    expect(() => assertScope(scopes({ shell: "off" }), "shell")).toThrow(/Run commands/);
    expect(() => assertScope(scopes({ write: "off" }), "write")).toThrow(/Create and change files/);
    expect(() => assertScope(scopes({ screen: "off" }), "screen")).toThrow(/See the screen/);
    expect(() => assertScope(scopes({ sandboxes: "off" }), "sandboxes")).toThrow(/Manage sandboxes on this device/);
    expect(() => assertScope(scopes(), "shell")).not.toThrow();
});
