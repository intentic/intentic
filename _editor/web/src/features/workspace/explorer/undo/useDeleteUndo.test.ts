import "@intentic/testing/dom";
import type { LocalFace } from "../../../../app/environments/local";
import type { DeleteBatch } from "./deleteUndo";

// Pins what a delete's receipt promises: an Undo only for a batch this tab holds an id to take back by, and, in a local
// window, where the files went instead. The daemon's store is the seam; the receipt is read off the notification lane.

jest.mock("../useWorkspaceTree", () => ({
    useWorkspaceTree: () => ({
        run: async (task: () => Promise<void>): Promise<void> => task(),
        restoreDeleted: async (): Promise<{ landed: readonly string[]; gone: number }> => ({ landed: [], gone: 0 }),
    }),
}));

const { useDeleteUndo } = await import("./useDeleteUndo");
const { useNotifications } = await import("../../../../workbench/notifications/notifications");

const FACE: LocalFace = { daemonUrl: `http://127.0.0.1:47201`, token: `t`.repeat(64), id: `w1`, name: `project`, path: `/home/me/project` };
const WINDOWS = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0`;
const MAC = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)`;
const TAKEN: DeleteBatch = { entries: [{ path: `a.md`, type: `file`, trashed: `t:a.md` }] };
const UNTAKEN: DeleteBatch = { entries: [] };

const agent = navigator.userAgent;
const runningOn = (userAgent: string): void => {
    Object.defineProperty(navigator, `userAgent`, { configurable: true, value: userAgent });
};
afterEach(() => {
    delete window.__INTENTIC_LOCAL__;
    runningOn(agent);
    useNotifications().dismissReceipt();
});

// The receipt as a reader meets it: its line, its second line, and the buttons on it.
const said = (): readonly (string | undefined)[] => {
    const shown = useNotifications().receipt.value;
    return [shown?.title, shown?.detail, ...(shown?.actions ?? []).map((action) => action.label)];
};

test("a delete this tab can take back offers its Undo, and one it cannot offers none", () => {
    const { sayDeleted } = useDeleteUndo();
    sayDeleted(`a.md deleted`, TAKEN);
    const taken = said();
    sayDeleted(`a.md deleted`, UNTAKEN);
    expect([taken, said()]).toEqual([
        [`a.md deleted`, undefined, `Undo`],
        [`a.md deleted`, undefined],
    ]);
});

test("a local window's delete says which of the system's trashes it went to, and promises no Undo", () => {
    window.__INTENTIC_LOCAL__ = FACE;
    const { sayDeleted } = useDeleteUndo();
    runningOn(WINDOWS);
    sayDeleted(`3 items deleted`, UNTAKEN);
    const onWindows = said();
    runningOn(MAC);
    sayDeleted(`a.md deleted`, UNTAKEN);
    expect([onWindows, said()]).toEqual([
        [`3 items deleted`, `Moved to the Recycle Bin`],
        [`a.md deleted`, `Moved to the Trash`],
    ]);
});
