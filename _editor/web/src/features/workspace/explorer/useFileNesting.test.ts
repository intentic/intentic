import { freshImport } from "@intentic/testing/bun";
import type { LocalFace } from "../../../app/environments/local";

// Whether package.json folds its package's files, read the way each kind of window starts: a sandbox's tree nests,
// a local window's (the desktop app's, on a folder of this computer) shows the folder as its file manager does, and a
// choice the reader made holds in both. The module holds the preference from its first import, so each read is fresh.

const KEY = `ui-file-nesting`;
const FACE: LocalFace = { daemonUrl: `http://127.0.0.1:47201`, token: `t`.repeat(64), id: `w1`, name: `project`, path: `/home/me/project` };

const nestingIn = async (face: LocalFace | undefined): Promise<boolean> => {
    window.__INTENTIC_LOCAL__ = face;
    const { useFileNesting } = await freshImport<typeof import("./useFileNesting")>(`./useFileNesting`, import.meta.url);
    return useFileNesting().fileNesting.value;
};

afterEach(() => {
    delete window.__INTENTIC_LOCAL__;
    localStorage.removeItem(KEY);
});

test("unset, a sandbox's tree nests and a local window's does not, and neither writes its default down", async () => {
    expect([await nestingIn(undefined), await nestingIn(FACE)]).toEqual([true, false]);
    expect(localStorage.getItem(KEY)).toBeNull();
});

test("a choice the reader made wins in either kind of window", async () => {
    localStorage.setItem(KEY, `on`);
    const onInLocal = await nestingIn(FACE);
    localStorage.setItem(KEY, `off`);
    expect([onInLocal, await nestingIn(undefined), await nestingIn(FACE)]).toEqual([true, false, false]);
});
