import type { LocalFoundProject, LocalFoundProvider, LocalPlace } from "../app/environments/localHost";
import { foundSubscriptions, type OfferedProject, offeredProjects, projectPlaces, subscriptionName, toolName, toolNames, whereOf } from "./foundProjects";

// An empty main window offers the folders this computer already works in: the ones opened here first, then the ones the
// AI tools and editors name, one row per folder.

const place = (path: string, extra: Partial<LocalPlace> = {}): LocalPlace => ({ path, folder: true, openedAt: 1_790_000_000, exists: true, sandbox: false, ...extra });

const found = (path: string, extra: Partial<LocalFoundProject> = {}): LocalFoundProject => ({
    path,
    shown: path,
    name: path.split(/[\\/]/u).at(-1) ?? path,
    sources: [`claude-code`],
    lastActive: 1_790_100_000,
    wsl: null,
    git: true,
    sandbox: false,
    ...extra,
});

it(`offers what was opened here first, then what the tools found, each folder once`, () => {
    const offered = offeredProjects(
        [place(`C:\\Users\\ada\\code\\shop`), place(`C:\\Users\\ada\\notes.md`, { folder: false }), place(`C:\\Users\\ada\\gone`, { exists: false })],
        [found(`c:/users/ada/code/shop`, { sources: [`vscode`], sandbox: true }), found(`C:\\Users\\ada\\code\\api`)],
        [],
    );
    expect(offered.map((project) => project.name)).toEqual([`shop`, `api`]);
    expect(offered[0]).toMatchObject({ openedHere: true, sources: [`vscode`], sandbox: true, git: true, at: 1_790_100_000_000 });
    expect(offered[1]).toMatchObject({ openedHere: false, sources: [`claude-code`] });
});

it(`never offers the folder the window shows or the app's own starting folder`, () => {
    const offered = offeredProjects(
        [place(`C:\\Users\\ada\\intentic\\local`)],
        [found(`C:\\Users\\ada\\intentic\\local\\`), found(`/home/ada/app`)],
        [`C:\\Users\\ada\\intentic\\local`, ``],
    );
    expect(offered.map((project) => project.path)).toEqual([`/home/ada/app`]);
});

it(`keeps a distro's folder by the path Windows opens it at, read as the distro spells it`, () => {
    const [api] = offeredProjects([], [found(`\\\\wsl.localhost\\Ubuntu\\home\\ada\\api`, { shown: `/home/ada/api`, wsl: `Ubuntu` })], []);
    expect(api).toMatchObject({ path: `\\\\wsl.localhost\\Ubuntu\\home\\ada\\api`, shown: `/home/ada/api`, wsl: `Ubuntu`, name: `api` });
    const [recent] = offeredProjects([place(`\\\\wsl$\\Debian\\home\\ada\\site`)], [], []);
    expect(recent?.wsl).toBe(`Debian`);
});

it(`knows a distro's folder by its Windows path when the tool that named it did not say, and reads drive paths one way`, () => {
    // A Windows tool run in a distro's folder records only `\\wsl.localhost\…`, with no distro beside it.
    const unc = `\\\\wsl.localhost\\archlinux\\home\\ada\\intentic`;
    const [fromWindows] = offeredProjects([], [found(unc, { shown: unc, wsl: null })], []);
    expect(fromWindows).toMatchObject({ path: unc, shown: `/home/ada/intentic`, wsl: `archlinux` });
    const [recent] = offeredProjects([place(unc)], [], []);
    expect(recent).toMatchObject({ shown: `/home/ada/intentic`, wsl: `archlinux` });
    const [slashed] = offeredProjects([], [found(`C:/Users/ada/code/mig`)], []);
    expect(slashed?.shown).toBe(`C:\\Users\\ada\\code\\mig`);
});

const offer = (name: string, extra: Partial<OfferedProject> = {}): OfferedProject => ({
    path: `/home/ada/${name}`,
    shown: `/home/ada/${name}`,
    name,
    openedHere: false,
    sources: [],
    at: undefined,
    wsl: undefined,
    git: false,
    sandbox: false,
    ...extra,
});

it(`groups the folders by where they live, each newest first and the most recently used place on top`, () => {
    const places = projectPlaces([
        offer(`old`, { at: 1_000 }),
        offer(`api`, { wsl: `Ubuntu`, at: 2_000 }),
        offer(`undated`),
        offer(`new`, { at: 3_000 }),
        offer(`site`, { wsl: `Ubuntu`, at: 5_000 }),
        offer(`tool`, { wsl: `Debian`, at: 4_000 }),
    ]);
    expect(places.map((group) => [group.wsl, group.projects.map((project) => project.name)])).toEqual([
        [`Ubuntu`, [`site`, `api`]],
        [`Debian`, [`tool`]],
        [undefined, [`new`, `old`, `undated`]],
    ]);
});

it(`says where a folder sits, short: its parent, home as ~`, () => {
    expect(whereOf({ shown: `/home/ada/repositories/api`, name: `api` })).toBe(`~/repositories`);
    expect(whereOf({ shown: `/home/ada/api`, name: `api` })).toBe(`~`);
    expect(whereOf({ shown: `/Users/ada/code/api/`, name: `api` })).toBe(`~/code`);
    expect(whereOf({ shown: `C:\\Users\\ada\\repositories\\mig`, name: `mig` })).toBe(`~\\repositories`);
    expect(whereOf({ shown: `D:\\mig`, name: `mig` })).toBe(`D:\\`);
    expect(whereOf({ shown: `/srv/api`, name: `api` })).toBe(`/srv`);
    expect(whereOf({ shown: `/api`, name: `api` })).toBe(`/`);
    // A folder that goes by another name than its last part is shown whole.
    expect(whereOf({ shown: `/home/ada/work/checkout-3`, name: `shop` })).toBe(`~/work/checkout-3`);
    expect(whereOf({ shown: `/home/adam/x/y`, name: `y` })).toBe(`~/x`);
});

it(`stops at its limit, and reads every way the app keeps a time`, () => {
    const many = Array.from({ length: 20 }, (_, index) => found(`/home/ada/p${index}`));
    expect(offeredProjects([], many, [])).toHaveLength(8);
    expect(offeredProjects([place(`/a`, { openedAt: 1_790_000_000_000 })], [], [])[0]?.at).toBe(1_790_000_000_000);
    expect(offeredProjects([place(`/a`, { openedAt: `2026-10-05T10:00:00Z` })], [], [])[0]?.at).toBe(Date.parse(`2026-10-05T10:00:00Z`));
    expect(offeredProjects([place(`/a`, { openedAt: `soon` })], [], [])[0]?.at).toBeUndefined();
    expect(offeredProjects([], [found(`/a`, { lastActive: null })], [])[0]?.at).toBeUndefined();
});

it(`names tools and subscriptions as people know them`, () => {
    expect(toolName(`claude-code`)).toBe(`Claude Code`);
    expect(toolName(`something-new`)).toBe(`something-new`);
    expect(toolNames([`codex`, `vscode`, `codex`])).toBe(`Codex, VS Code`);
    const provider = (id: string, plan: string | null): LocalFoundProvider => ({ provider: id, tools: [`claude-code`], email: null, plan, wsl: null });
    expect(subscriptionName(provider(`claude`, `max`))).toBe(`Claude (Max)`);
    expect(subscriptionName(provider(`codex`, null))).toBe(`ChatGPT`);
    expect(subscriptionName(provider(`zed`, ` `))).toBe(`zed`);
    expect(foundSubscriptions([provider(`claude`, null), provider(`codex`, null), provider(`claude`, `max`)]).map((p) => p.provider)).toEqual([`claude`, `codex`]);
});
