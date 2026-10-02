import { applyTerminalGrid, requestTerminalGrid, resetTerminalGrid, type TerminalSizing } from "./terminalSizing";

const session = (): TerminalSizing => {
    const term = {
        cols: 120,
        rows: 40,
        resize(cols: number, rows: number): void {
            this.cols = cols;
            this.rows = rows;
        },
    };
    return { requestedGrid: { cols: 120, rows: 40 }, term };
};

it(`renders the shared grid while continuing to report its own viewport without feedback`, () => {
    const s = session();
    applyTerminalGrid(s, { cols: 80, rows: 24 });
    expect([s.term.cols, s.term.rows]).toEqual([80, 24]);
    expect(s.requestedGrid).toEqual({ cols: 120, rows: 40 });
    expect(requestTerminalGrid(s, { cols: 120, rows: 40 })).toBe(false);
    expect(requestTerminalGrid(s, { cols: 100, rows: 30 })).toBe(true);
    expect([s.term.cols, s.term.rows]).toEqual([80, 24]);
    expect(s.requestedGrid).toEqual({ cols: 100, rows: 30 });
    applyTerminalGrid(s, { cols: 100, rows: 30 });
    expect([s.term.cols, s.term.rows]).toEqual([100, 30]);
});

it(`fits locally with an older front, including after reconnecting from a newer one`, () => {
    const s = session();
    requestTerminalGrid(s, { cols: 90, rows: 20 });
    expect([s.term.cols, s.term.rows]).toEqual([90, 20]);
    applyTerminalGrid(s, { cols: 60, rows: 15 });
    resetTerminalGrid(s);
    expect([s.term.cols, s.term.rows]).toEqual([90, 20]);
    requestTerminalGrid(s, { cols: 110, rows: 35 });
    expect([s.term.cols, s.term.rows]).toEqual([110, 35]);
});
