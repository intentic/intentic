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

/* The link the app hears from a local window (setup_link.rs `LocalVerb`): the verb, and a folder-relative path. */
test("a local window asks the app by link, the entry it means encoded", async () => {
    const location = { href: `` };
    stubGlobal(`location`, location);
    stubGlobal(`document`, { readyState: `complete` });
    const { askLocalApp } = await load(FACE);
    askLocalApp(`reveal`, `docs/a b.md`);
    expect(location.href).toBe(`intentic://local?do=reveal&path=docs%2Fa+b.md`);
    askLocalApp(`open-folder`);
    expect(location.href).toBe(`intentic://local?do=open-folder`);
});
