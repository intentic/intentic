import { startAppI18n } from "../../app/i18n";
import { projectCommands } from "./useProjectCommands";

// Pins the palette's half of choosing a project: a row per repository but the open one, and the way back while one is.

await startAppI18n();

const projects = new Set([`shop`, `apps/web`]);

it(`offers every project, sorted, and no way back while none is open`, () => {
    const rows = projectCommands(projects, undefined);
    expect(rows.map((row) => row.project)).toEqual([`apps/web`, `shop`]);
    expect(rows.map((row) => row.command)).toEqual([`project.focus.apps/web`, `project.focus.shop`]);
    expect(rows[1]?.title).toContain(`shop`);
});

it(`leads with the way back to every project while one is open, and drops the open one`, () => {
    const rows = projectCommands(projects, `shop`);
    expect(rows.map((row) => row.project)).toEqual([undefined, `apps/web`]);
    expect(rows[0]?.command).toBe(`project.showAll`);
});
