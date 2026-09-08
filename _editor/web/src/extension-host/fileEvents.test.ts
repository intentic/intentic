import { STATE_DIR } from "@intentic/constants";
import { afterEach, expect, it, vi } from "vitest";
import { emitFilesChanged, onFilesChanged } from "./fileEvents";

// Scoping rules for api.workspace.onDidChangeFiles: a subscriber must get exactly its own declared paths, no more, no
// less.

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

// A trailing slash marks a directory entry; it must not match a sibling file.
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

// An empty batch means the daemon lost track of what changed (per-frame cap overflow, reconnect), not that nothing did.
// It must wake every subscriber, since prefix matching against no paths would otherwise announce nothing for the
// largest changes.
it(`wakes every subscriber for its own paths when the batch says only "something, and we cannot say what"`, () => {
    const approvals = vi.fn();
    const chores = vi.fn();
    listen([`${STATE_DIR}/config/approvals/`], approvals);
    listen([`${STATE_DIR}/records/chores/`], chores);

    emitFilesChanged([]);

    expect(approvals).toHaveBeenCalledWith([`${STATE_DIR}/config/approvals/`]);
    expect(chores).toHaveBeenCalledWith([`${STATE_DIR}/records/chores/`]);
});

// An extension that declared no files hears nothing, including from the empty batch.
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
