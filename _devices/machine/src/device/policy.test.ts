import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { assertPath, assertScope, rootsOf, ScopeError, withinRoots } from "./policy.js";

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
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

// The owner narrowed the device and wrote it in a form this machine cannot resolve: that must never read as "nothing
// declared", which is the widest grant there is.
test("declared roots none of which is a full path confine to no folder, not to the home directory", async () => {
    const unusable = scopes({ roots: `projects\nDocuments/work` });
    expect(rootsOf(unusable)).toEqual([]);
    await expect(assertPath(join(homedir(), "projects", "notes.txt"), unusable, "read")).rejects.toThrow(
        `it is outside the folders this device allows (none, since no line of "Folders it may touch" is a full path)`,
    );
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

test("a path outside the roots is refused with the roots named, so the user knows what to widen", async () => {
    const allowed = scopes({ roots: "/srv/app" });
    await expect(assertPath("/etc/shadow", allowed, "read")).rejects.toThrow(ScopeError);
    await expect(assertPath("/etc/shadow", allowed, "read")).rejects.toThrow(/\/srv\/app/);
    expect(await assertPath("/srv/app/config.json", allowed, "read")).toBe(resolve("/srv/app/config.json"));
});

test("each switch refuses by naming the control on the card, not a mechanism", () => {
    expect(() => assertScope(scopes({ shell: "off" }), "shell")).toThrow(/Run commands/);
    expect(() => assertScope(scopes({ write: "off" }), "write")).toThrow(/Create and change files/);
    expect(() => assertScope(scopes({ screen: "off" }), "screen")).toThrow(/See the screen/);
    expect(() => assertScope(scopes({ sandboxes: "off" }), "sandboxes")).toThrow(/Manage sandboxes on this device/);
    expect(() => assertScope(scopes(), "shell")).not.toThrow();
});
