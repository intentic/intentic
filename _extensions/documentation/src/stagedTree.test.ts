import type { IntenticApi } from "@intentic/extension-api";
import { expect, test, vi } from "vitest";
import { stagingDir } from "./paths.js";
import { listStagedTails } from "./stagedTree.js";

test(`reads a nested staged document set in one bounded request`, async () => {
    const root = stagingDir(`intentic`);
    const json = vi.fn(async () => ({
        entries: [
            { name: `repo.json`, path: `${root}/repo.json`, type: `file` },
            { name: `_editor`, path: `${root}/_editor`, type: `dir` },
            { name: `web`, path: `${root}/_editor/web`, type: `dir` },
            { name: `README.md`, path: `${root}/_editor/web/README.md`, type: `file` },
        ],
        hidden: 0,
    }));
    const api = { sandbox: { json } } as unknown as IntenticApi;

    expect(await listStagedTails(api, `intentic`)).toEqual([`_editor/web/README.md`, `repo.json`]);
    expect(json).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith(`/workspace/children?path=${encodeURIComponent(root)}&depth=5`);
});
