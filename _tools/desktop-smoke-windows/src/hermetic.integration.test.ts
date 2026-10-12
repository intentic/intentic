import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchState, pinFiles } from "./hermetic.js";

// The install tier's launch is decided by the app's own files in its config directory, which outlive an uninstall on
// a runner that is also used: pinned for the run, and every one put back as it was, absent ones included.

const made: string[] = [];
afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const directory = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), `smoke-pin-`));
    made.push(dir);
    return dir;
};

test(`a launch is pinned to the workspace, on a PC hosting nothing, with no setup parked`, () => {
    const state = launchState(`http://127.0.0.1:4000`, `http://127.0.0.1:4000`);
    expect(JSON.parse(state.get(`last-face.json`) ?? `null`)).toBe(`workspace`);
    expect(JSON.parse(state.get(`hosts-sandboxes.json`) ?? `null`)).toBe(false);
    expect(state.has(`resume-setup.json`)).toBe(true);
    expect(state.get(`resume-setup.json`)).toBeUndefined();
    expect(JSON.parse(state.get(`settings.json`) ?? `{}`)).toEqual({ appUrl: `http://127.0.0.1:4000`, platformUrl: `http://127.0.0.1:4000` });
});

test(`pinned files are written or removed, and put back exactly as they were`, async () => {
    const dir = await directory();
    await writeFile(join(dir, `hosts-sandboxes.json`), `true`);
    await writeFile(join(dir, `resume-setup.json`), `{"args":{}}`);
    const restore = await pinFiles(
        dir,
        new Map([
            [`hosts-sandboxes.json`, `false`],
            [`resume-setup.json`, undefined],
            [`last-face.json`, `"workspace"`],
        ]),
    );
    expect(await readFile(join(dir, `hosts-sandboxes.json`), `utf8`)).toBe(`false`);
    expect(existsSync(join(dir, `resume-setup.json`))).toBe(false);
    expect(await readFile(join(dir, `last-face.json`), `utf8`)).toBe(`"workspace"`);
    // The app writes its own state while the tier runs; what was there before the run still comes back.
    await writeFile(join(dir, `last-face.json`), `"home"`);
    await restore();
    expect(await readFile(join(dir, `hosts-sandboxes.json`), `utf8`)).toBe(`true`);
    expect(await readFile(join(dir, `resume-setup.json`), `utf8`)).toBe(`{"args":{}}`);
    expect(existsSync(join(dir, `last-face.json`))).toBe(false);
});
