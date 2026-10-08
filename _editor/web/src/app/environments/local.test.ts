import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";

afterEach(unstubAllGlobals);

/* The page's window as local.ts reads it: an ordinary tab's until a test marks it as a local window of the app. */
const load = (local?: object): Promise<typeof import("./local")> => {
    stubGlobal(`window`, local === undefined ? {} : { __INTENTIC_LOCAL__: local });
    return freshImport<typeof import("./local")>("./local", import.meta.url);
};

const FACE = { daemonUrl: `http://127.0.0.1:47201`, token: `t`.repeat(64), id: `w1`, name: `project`, path: `/home/me/project` };

test("a window the app marked is a local window, and any other is not", async () => {
    expect((await load(FACE)).localFace()).toEqual(FACE);
    expect((await load()).localFace()).toBeUndefined();
});

/* What a local window runs of the compiled-in extensions: the viewers, and nothing that acts on a sandbox. */
test("a local window runs only the extensions that show files", async () => {
    const { LOCAL_EXTENSIONS } = await load(FACE);
    expect([...LOCAL_EXTENSIONS].sort()).toEqual([`intentic.onlyoffice`, `intentic.viewers`]);
});

// Every link the page hands the app, in order. Links leave one at a time, a beat apart (desktop.ts
// `openDesktopLink`), so the clock is faked and walked past each gap: what is asserted is what the app hears.
const heardLinks = (): string[] => {
    const heard: string[] = [];
    stubGlobal(`location`, {
        get href(): string {
            return heard.at(-1) ?? ``;
        },
        set href(link: string) {
            heard.push(link);
        },
    });
    stubGlobal(`document`, { readyState: `complete` });
    return heard;
};
const LINK_GAP_WALK_MS = 1_000;
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    jest.useRealTimers();
});

/* The link the app hears from a local window (setup_link.rs `LocalVerb`): the verb, and a folder-relative path. */
test("a local window asks the app by link, the entry it means encoded", async () => {
    const heard = heardLinks();
    const { askLocalApp } = await load(FACE);
    askLocalApp(`reveal`, { path: `docs/a b.md` });
    askLocalApp(`open-folder`);
    // A reveal with nothing picked names no entry, rather than an empty one.
    askLocalApp(`reveal`, { path: undefined });
    jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    expect(heard).toEqual([`intentic://local?do=reveal&path=docs%2Fa+b.md`, `intentic://local?do=open-folder`, `intentic://local?do=reveal`]);
});

/* The verbs about an agent and the folder's sandbox, each carrying its own one value under the name the app reads. */
test("a local window asks an agent about an entry, and asks its sandbox for changes, a bring-back, a restore and a direction", async () => {
    const heard = heardLinks();
    const { askLocalApp } = await load(FACE);
    const ask = (...args: Parameters<typeof askLocalApp>): void => {
        askLocalApp(...args);
        jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    };
    ask(`ask`, { path: `notes/plan.md` });
    ask(`changes`);
    ask(`bring-back`);
    ask(`bring-back`, { paths: [`a b.md`, `src/x&y.ts`] });
    ask(`restore`, { point: `rp-7` });
    ask(`direction`, { value: `both` });
    ask(`direction`, { value: `to-sandbox` });
    expect(heard).toEqual([
        `intentic://local?do=ask&path=notes%2Fplan.md`,
        `intentic://local?do=changes`,
        // Everything the sandbox changed: no list at all, never an empty one.
        `intentic://local?do=bring-back`,
        `intentic://local?do=bring-back&paths=%5B%22a+b.md%22%2C%22src%2Fx%26y.ts%22%5D`,
        `intentic://local?do=restore&point=rp-7`,
        `intentic://local?do=direction&value=both`,
        `intentic://local?do=direction&value=to-sandbox`,
    ]);
    // The list reads back as the paths chosen, whatever they hold.
    expect(JSON.parse(new URL(heard[3] ?? ``).searchParams.get(`paths`) ?? `null`)).toEqual([`a b.md`, `src/x&y.ts`]);
});

/* Another folder pointed at in the window's place (local/folderSwitch.ts): the window wears its face from then on, and
   what reads the face inside a computed reads it again, with no reload. */
test("a face worn in place is the window's from then on, and a computed reading it follows", async () => {
    const { localFace, wearFace } = await load(FACE);
    const { computed } = await import("vue");
    const name = computed(() => localFace()?.name);
    expect(name.value).toBe(`project`);
    wearFace({ ...FACE, id: `w2`, name: `other`, path: `/home/me/other` });
    expect(name.value).toBe(`other`);
    expect(localFace()).toEqual({ ...FACE, id: `w2`, name: `other`, path: `/home/me/other` });
});

test("a folder is the editor's sandbox `local-<id>`, whatever else its face says", async () => {
    const { localSandboxId } = await load(FACE);
    expect(localSandboxId(FACE)).toBe(`local-w1`);
});

/* What the app hands over crossed a process boundary: a whole face is one, and anything short of it is nothing. */
test("a face handed over by the app is read only when it is whole", async () => {
    const { faceOf } = await load(FACE);
    expect(faceOf(FACE)).toEqual(FACE);
    expect(faceOf({ ...FACE, file: `notes.md`, sandbox: true, home: false })).toEqual({ ...FACE, file: `notes.md`, sandbox: true, home: false });
    expect(faceOf({ ...FACE, token: undefined })).toBeUndefined();
    expect(faceOf({ ...FACE, sandbox: `yes` })).toBeUndefined();
    expect(faceOf(`face`)).toBeUndefined();
    expect(faceOf(null)).toBeUndefined();
});
