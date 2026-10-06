import type { Terminal } from "@xterm/xterm";

export type Grid = { cols: number; rows: number };
export type TerminalSizing = {
    requestedGrid: Grid;
    authoritativeGrid?: Grid;
    term: Pick<Terminal, `cols` | `rows` | `resize`>;
};

const render = (s: TerminalSizing): void => {
    const grid = s.authoritativeGrid ?? s.requestedGrid;
    if (s.term.cols !== grid.cols || s.term.rows !== grid.rows) {
        s.term.resize(grid.cols, grid.rows);
    }
};

// A viewport reports its capacity, never the smaller shared grid it has been asked to render.
export const requestTerminalGrid = (s: TerminalSizing, grid: Grid): boolean => {
    const changed = s.requestedGrid.cols !== grid.cols || s.requestedGrid.rows !== grid.rows;
    s.requestedGrid = grid;
    render(s);
    return changed;
};

export const applyTerminalGrid = (s: TerminalSizing, grid: Grid): void => {
    s.authoritativeGrid = grid;
    render(s);
};

// A reconnect may reach an older netd that never announces a grid; local fitting remains its fallback.
export const resetTerminalGrid = (s: TerminalSizing): void => {
    s.authoritativeGrid = undefined;
    render(s);
};
