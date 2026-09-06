// @vitest-environment jsdom
//
// WHAT AN INVITED MEMBER MEETS IN THE EXPLORER, below the tier that may write.
//
// jsdom because the subject is a GESTURE and its answer: the keystroke reaches the component, the component
// decides, and what the member sees afterwards is either a refusal in words or nothing at all. Nothing at all is
// what this file exists to prevent: the explorer used to offer every file action to every member and let the
// daemon refuse it a request later (a 403 from auth/role-floor.ts), which arrived as a truncated line in a
// toolbar and read as a Delete key that does nothing.
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};

const SANDBOX = `sb-shared`;
localStorage.setItem(`intentic.activeSandboxId`, SANDBOX);

// Every daemon call this view makes, recorded. The assertion that matters is an ABSENCE: a refused gesture must
// not reach the daemon at all, rather than being sent and answered with a 403.
const daemon = vi.hoisted(() => ({ calls: [] as { path: string; init?: RequestInit }[] }));
vi.mock("../../sandbox/client/sandboxClient", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../sandbox/client/sandboxClient")>();
    return {
        ...original,
        sandboxJson: async (path: string, init?: RequestInit): Promise<unknown> => {
            daemon.calls.push({ path, init });
            return { ok: true };
        },
    };
});

// The signed-in member's tier, switched per test. Mocked rather than driven through the platform's sandbox list
// (the precedent is AgentDetail.test.ts): the subject here is what the explorer does with the answer, not how
// the answer is fetched.
const role = vi.hoisted(() => ({ canShip: false }));
vi.mock("../../sandbox/secrets/useRole", async () => {
    const { computed } = await import("vue");
    return {
        useRole: () => ({
            role: computed(() => (role.canShip ? `maintainer` : `collaborator`)),
            canDrive: computed(() => true),
            canShip: computed(() => role.canShip),
            isOwner: computed(() => false),
        }),
    };
});

const { default: WorkspaceTree } = await import("./WorkspaceTree.vue");
const { resetWorkspaceTreeState, useWorkspaceTree } = await import("./useWorkspaceTree");
const { queryClient } = await import("../../../lib/queryPersistence");

const file = (path: string): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type: `file` });
const TREE: WorkspaceTreeEntry[] = [file(`README.md`), file(`notes.txt`)];

let app: App | undefined;
/* The shared file-action feedback, taken from inside a setup() (vue-query's client is injected, so the
 * composable cannot be called from a test body). This is the same object the desktop toolbar renders, so
 * reading it here is reading what the member is shown. */
let feedback: ReturnType<typeof useWorkspaceTree> | undefined;

const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        setup() {
            feedback = useWorkspaceTree();
            return () => h(WorkspaceTree, { tree: TREE });
        },
    });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

const rowFor = (el: HTMLElement, name: string): HTMLElement =>
    [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.includes(name)) as HTMLElement;

beforeEach(() => {
    role.canShip = false;
    daemon.calls.length = 0;
    sessionStorage.clear();
    resetWorkspaceTreeState();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
});

it(`answers a read-only member's Delete with the tier, and asks the daemon nothing`, async () => {
    const el = await mount();
    const row = rowFor(el, `notes.txt`);
    row.click();
    await nextTick();
    row.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Delete`, bubbles: true }));
    await nextTick();

    // Nothing was sent: the refusal is local, so there is no request to fail and no window in which the row
    // looks deleted.
    expect(daemon.calls.filter((call) => call.init?.method === `DELETE`)).toEqual([]);
    // And the confirm dialog never stood in for an answer either.
    expect(document.body.textContent).not.toContain(`Delete file?`);
    // What the member gets instead is the sentence, on the line every other file failure uses.
    expect(feedback?.actionError.value?.title).toMatch(/maintainer access/i);
});

it(`does not open the rename field for a read-only member`, async () => {
    const el = await mount();
    const row = rowFor(el, `notes.txt`);
    row.click();
    await nextTick();
    row.dispatchEvent(new KeyboardEvent(`keydown`, { key: `F2`, bubbles: true }));
    await nextTick();

    expect(el.querySelector(`input`)).toBeNull();
    expect(feedback?.actionError.value?.title).toMatch(/maintainer access/i);
});

it(`lets the operating tier through unchanged`, async () => {
    role.canShip = true;
    const el = await mount();
    const row = rowFor(el, `notes.txt`);
    row.click();
    await nextTick();
    row.dispatchEvent(new KeyboardEvent(`keydown`, { key: `F2`, bubbles: true }));
    await nextTick();

    // The same keystroke that was refused above opens the inline name field, and raises no complaint.
    expect(el.querySelector(`input`)).not.toBeNull();
    expect(feedback?.actionError.value).toBeUndefined();
});
