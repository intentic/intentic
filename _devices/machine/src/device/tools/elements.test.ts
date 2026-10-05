import { ElementRefs, FrameLog } from "@intentic/desktop-automation";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { createIndicator, type Indicator } from "../indicator.js";
import { ScopeError } from "../policy.js";
import { fakeDesktop, fakeElement, fakeIndicatorDeps } from "../device-testing.js";
import { actOnElement, listElements } from "./elements.js";

/* A window's controls as the agent reads and operates them: which earn a line, what a ref is good for and for how
   long, and that acting without the pointer is held to the same switches as acting with it. */

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "on",
    ...overrides,
});

const indicator = (): Indicator => createIndicator(fakeIndicatorDeps().deps);

const refOf = (listing: string, name: string): string => {
    const ref = new RegExp(`^([a-z]{2}\\d+) .*"${name}"`, "m").exec(listing)?.[1];
    if (ref === undefined) {
        throw new Error(`no ref for ${name} in:\n${listing}`);
    }
    return ref;
};

test("a listing shows what a person could operate, by name, and leaves layout out", async () => {
    const fake = fakeDesktop();
    fake.elements = [
        fakeElement({ id: "1", role: "pane", name: "", actions: [] }),
        fakeElement({ id: "2", role: "button", name: "Save", bounds: { x: 1920, y: 0, width: 80, height: 30 } }),
        fakeElement({ id: "3", role: "edit", name: "", value: "draft", actions: ["set_value", "focus"] }),
        fakeElement({ id: "4", role: "text", name: "Total: 42", actions: [] }),
        fakeElement({ id: "5", role: "check box", name: "Wrap", value: "Off", actions: ["toggle"], enabled: false }),
    ];
    const listing = await listElements(fake.desktop, {}, scopes(), new ElementRefs(), new FrameLog());
    expect(listing).toMatch(/^Window \[1\] "Untitled" \(app\): 3 controls\./);
    expect(listing).toContain('button "Save"');
    expect(listing).toContain('edit "" = "draft"');
    expect(listing).toContain('check box "Wrap" = "Off"');
    expect(listing).toContain("(disabled)");
    expect(listing).not.toContain("Total: 42");
    // Placed in the pixels of a whole-desktop screenshot, which the fake's 3840-wide desktop is shown at 1456.
    expect(listing).toMatch(/"Save" at 728,0 /);
    // A query reaches labels too, which is how a value on screen is found by what it says.
    expect(await listElements(fake.desktop, { query: "total" }, scopes(), new ElementRefs(), new FrameLog())).toContain('text "Total: 42"');
    await expect(listElements(fake.desktop, {}, scopes({ screen: "off" }), new ElementRefs(), new FrameLog())).rejects.toThrow(ScopeError);
});

test("acting on an element goes through its own action, and only one it offers", async () => {
    const fake = fakeDesktop();
    const refs = new ElementRefs();
    fake.elements = [fakeElement({ id: "2", role: "button", name: "Save" }), fakeElement({ id: "3", role: "edit", name: "Name", actions: ["set_value"] })];
    const listing = await listElements(fake.desktop, { window: "77" }, scopes(), refs, new FrameLog());
    expect(await actOnElement(fake.desktop, { element: refOf(listing, "Save"), action: "invoke" }, scopes(), refs, indicator())).toMatch(/^Pressed the button "Save"/);
    expect(await actOnElement(fake.desktop, { element: refOf(listing, "Name"), action: "set_value", value: "hunter2" }, scopes(), refs, indicator())).toBe(
        `Set the edit "Name" to 7 characters (${refOf(listing, "Name")}).`,
    );
    expect(fake.calls).toEqual(["invoke 77/2", "set_value 77/3 hunter2"]);
    await expect(actOnElement(fake.desktop, { element: refOf(listing, "Save"), action: "toggle" }, scopes(), refs, indicator())).rejects.toThrow(
        /does not offer toggle; it offers invoke, focus/,
    );
    await expect(actOnElement(fake.desktop, { element: refOf(listing, "Name"), action: "set_value" }, scopes(), refs, indicator())).rejects.toThrow(/"value"/);
});

test("refs hold until the next listing, and acting needs the control switch and, for a command, the destructive one", async () => {
    const fake = fakeDesktop();
    const refs = new ElementRefs();
    fake.elements = [fakeElement({ id: "3", role: "edit", name: "Terminal input", actions: ["set_value"] })];
    const old = refOf(await listElements(fake.desktop, {}, scopes(), refs, new FrameLog()), "Terminal input");
    await expect(actOnElement(fake.desktop, { element: old, action: "set_value", value: "x" }, scopes({ control: "off" }), refs, indicator())).rejects.toThrow(
        ScopeError,
    );
    await expect(
        actOnElement(fake.desktop, { element: old, action: "set_value", value: "rm -rf ~\n" }, scopes({ destructive: "off" }), refs, indicator()),
    ).rejects.toThrow(/Run destructive commands/);
    await listElements(fake.desktop, {}, scopes(), refs, new FrameLog());
    await expect(actOnElement(fake.desktop, { element: old, action: "set_value", value: "x" }, scopes(), refs, indicator())).rejects.toThrow(
        /older list of elements/,
    );
    expect(fake.calls).toEqual([]);
});
