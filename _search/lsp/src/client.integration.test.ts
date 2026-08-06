import { mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { diagnoseVia } from "./client.js";
import { Daemon } from "./daemon.js";
import { socketPathFor } from "./protocol.js";

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-client-"));
    // A .git is what marks the workspace root the daemon is keyed on, and a tsconfig what makes the tree
    // answerable at all.
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, types: [] },
            include: ["*.ts"],
        }),
    );
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, name), content);
    }
    return dir;
};

/* The socket name is the load-bearing part of reaching a service across a mount boundary: a hook outside a
 * turn's namespace can only derive the socket of a daemon inside it if the two names of that one directory
 * agree on it. Identity, not path — so a symlink and its target converge, which is the same property read
 * through something a test can actually build. */
test("two names for one directory name one socket", async () => {
    const dir = await scaffold({});
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    expect(socketPathFor(link)).toBe(socketPathFor(dir));
});

test("two different directories do not", async () => {
    expect(socketPathFor(await scaffold({}))).not.toBe(socketPathFor(await scaffold({})));
});

/* A service that has to stand somewhere else is started through the caller's wrapper and nowhere else — in
 * production that wrapper is `nsenter` into the turn's namespace, the one view where the turn's dependencies
 * exist. Spawned directly instead, it would come up blind and answer about a tree with nothing installed in it,
 * which is the failure this whole path exists to end. The daemon it is asked to start is named with the FAR-side
 * root, because that is the name it will have to work in. */
test("a service location starts the daemon through the caller's wrapper, in the far-side naming", async () => {
    const dir = await scaffold({ "bad.ts": "export const n: number = 'no';\n" });
    // Stands in for the same tree seen from the other side of a mount boundary: one directory, two names.
    const view = `${dir}-view`;
    symlinkSync(dir, view);
    const wrapped: string[][] = [];
    const daemon = new Daemon({ root: dir });
    try {
        const report = await diagnoseVia(dir, {
            files: [join(dir, "bad.ts")],
            touched: [join(dir, "bad.ts")],
            service: {
                reachableCwd: view,
                // What `nsenter` does in production, minus the namespace: whatever the wrapper brings up is what
                // answers, and a daemon spawned around it would answer about the wrong tree.
                enter: (command, args) => {
                    wrapped.push([command, ...args]);
                    void daemon.listen();
                    return { command: "true", args: [] };
                },
            },
        });
        expect(wrapped).toHaveLength(1);
        expect(wrapped[0]?.slice(1)).toEqual([expect.stringContaining("cli"), "daemon", dir]);
        // Reached under the name the caller could stat, and answering about the files it asked with.
        expect(report?.diagnostics.map((d) => d.code)).toEqual([2322]);
    } finally {
        await daemon.close();
    }
});

/* The rendezvous itself, which is what makes placing the service elsewhere workable at all: a caller that knows
 * a directory by one name finds — and is answered by — a daemon that knows it by another, without starting
 * anything. In production those two names are the same tree inside and outside a turn's mount namespace; here
 * they are a symlink and its target, which is the same fact about identity in a form a test can build. */
test("a caller finds a running daemon under a different name for the same directory", async () => {
    const dir = await scaffold({ "bad.ts": "export const n: number = 'no';\n" });
    const daemon = new Daemon({ root: dir });
    await daemon.listen();
    const view = `${dir}-view`;
    symlinkSync(dir, view);
    try {
        const report = await diagnoseVia(view, {
            files: [join(view, "bad.ts")],
            touched: [join(view, "bad.ts")],
            service: {
                reachableCwd: dir,
                enter: () => {
                    throw new Error("a reachable daemon must be used, not a second one spawned");
                },
            },
        });
        expect(report?.diagnostics.map((d) => d.code)).toEqual([2322]);
    } finally {
        await daemon.close();
    }
});
