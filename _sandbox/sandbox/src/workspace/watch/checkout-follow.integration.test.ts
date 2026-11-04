import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckoutFollow } from "./checkout-follow.js";

// The platform's own watch under the follow registry: a file written into a followed folder of a real directory is
// told, a file in a folder beneath it is not (one level deep), and a folder removed lets its watch go.

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await delay(25);
    }
};

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "checkout-follow-"));
    await mkdir(join(root, "docs", "deep"), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("a write into a followed folder is told, one beneath it is not", async () => {
    const follow = createCheckoutFollow({ debounceMs: 20 });
    const told: string[] = [];
    follow.subscribe((agent, paths) => told.push(...paths.map((path) => `${agent}:${path}`)));
    try {
        follow.follow("c-1", root, ["docs"]);
        await writeFile(join(root, "docs", "deep", "hidden.md"), "nested");
        await writeFile(join(root, "docs", "report.md"), "# draft");
        await waitFor(() => told.includes("c-1:docs/report.md"), 3000);
        expect(told).toContain("c-1:docs/report.md");
        expect(told).not.toContain("c-1:docs/deep/hidden.md");
    } finally {
        follow.close();
    }
});

test("a followed folder removed lets its watch go", async () => {
    const follow = createCheckoutFollow({ debounceMs: 20 });
    try {
        follow.follow("c-1", root, ["docs/deep"]);
        expect(follow.watched()).toBe(1);
        await rm(join(root, "docs", "deep"), { recursive: true });
        await waitFor(() => follow.watched() === 0, 3000);
        expect(follow.watched()).toBe(0);
    } finally {
        follow.close();
    }
});
