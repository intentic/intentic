import { STATE_DIR } from "@intentic/constants";
import { afterEach, expect, it, vi } from "vitest";
import { emitFilesChanged, onFilesChanged } from "./fileEvents";

/* The scoping rules behind `api.workspace.onDidChangeFiles`, which are the whole substance of this channel: the
 * fan-out is three lines, and every way it can be wrong is a way a badge either misses its own news or is woken
 * by somebody else's. */

const disposables: { dispose: () => void }[] = [];
const listen = (paths: readonly string[], listener: (paths: readonly string[]) => void): void => {
    disposables.push(onFilesChanged(paths, listener));
};

afterEach(() => {
    for (const disposable of disposables.splice(0)) {
        disposable.dispose();
    }
});

it(`wakes a subscriber only for writes under its own declared paths`, () => {
    const approvals = vi.fn();
    const chores = vi.fn();
    listen([`${STATE_DIR}/config/approvals/`], approvals);
    listen([`${STATE_DIR}/records/chores/`], chores);

    emitFilesChanged([`${STATE_DIR}/config/approvals/proposal.json`]);

    expect(approvals).toHaveBeenCalledWith([`${STATE_DIR}/config/approvals/proposal.json`]);
    expect(chores).not.toHaveBeenCalled();
});

// The trailing slash is what makes a directory entry a directory entry, on this side as much as on the daemon's.
it(`does not let a directory entry match a sibling file`, () => {
    const listener = vi.fn();
    listen([`${STATE_DIR}/config/approvals/`], listener);

    emitFilesChanged([`${STATE_DIR}/config/approvals-backup.json`]);

    expect(listener).not.toHaveBeenCalled();
});

it(`hands over only the matching paths, not the whole batch`, () => {
    const listener = vi.fn();
    listen([`${STATE_DIR}/config/approvals/`], listener);

    emitFilesChanged([`README.md`, `${STATE_DIR}/config/approvals/one.json`, `${STATE_DIR}/records/chores/report.json`]);

    expect(listener).toHaveBeenCalledWith([`${STATE_DIR}/config/approvals/one.json`]);
});

/* THE FRAME THAT MEANS THE MOST MUST NOT BE THE FRAME THAT DOES NOTHING. The daemon sends no path list at all
 * past its per-frame cap (a branch switch, a codegen run, a mass delete), and a reconnect reuses the same empty
 * batch to say "frames may have been lost". Matched against a prefix table, "no paths" matches nothing, so
 * exactly the largest changes would have gone unannounced. */
it(`wakes every subscriber for its own paths when the batch says only "something, and we cannot say what"`, () => {
    const approvals = vi.fn();
    const chores = vi.fn();
    listen([`${STATE_DIR}/config/approvals/`], approvals);
    listen([`${STATE_DIR}/records/chores/`], chores);

    emitFilesChanged([]);

    expect(approvals).toHaveBeenCalledWith([`${STATE_DIR}/config/approvals/`]);
    expect(chores).toHaveBeenCalledWith([`${STATE_DIR}/records/chores/`]);
});

// An extension that declared no files claimed nothing, so it hears nothing, including from the empty batch.
it(`never wakes a subscriber that declared no files`, () => {
    const listener = vi.fn();
    listen([], listener);

    emitFilesChanged([`${STATE_DIR}/config/approvals/one.json`]);
    emitFilesChanged([]);

    expect(listener).not.toHaveBeenCalled();
});

it(`stops delivering once disposed`, () => {
    const listener = vi.fn();
    const subscription = onFilesChanged([`${STATE_DIR}/config/approvals/`], listener);

    subscription.dispose();
    emitFilesChanged([`${STATE_DIR}/config/approvals/one.json`]);

    expect(listener).not.toHaveBeenCalled();
});

// One extension's broken listener must not cost every other extension its notification.
it(`keeps going when a listener throws`, () => {
    const after = vi.fn();
    const thrower = vi.spyOn(console, `error`).mockImplementation(() => {});
    listen([`${STATE_DIR}/config/approvals/`], () => {
        throw new Error(`badge derivation failed`);
    });
    listen([`${STATE_DIR}/config/approvals/`], after);

    emitFilesChanged([`${STATE_DIR}/config/approvals/one.json`]);

    expect(after).toHaveBeenCalledTimes(1);
    thrower.mockRestore();
});
