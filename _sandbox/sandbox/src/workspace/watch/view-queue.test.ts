import { WORKSPACE_ROOT } from "@intentic/constants";
import type { WorkspaceTree } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { viewQueue } from "./view-queue.js";

// The watch thread's line: an ask for the tree shares the view at the line's tail only while nothing that can move
// the tree has been queued behind it, so a shared answer is the one an ask of its own would have got.

// A tree that is only a generation, moved by each change the test queues, counting the views taken of it.
const counted = () => {
    let generation = 0;
    let taken = 0;
    let broken = false;
    const take = (): WorkspaceTree => {
        taken += 1;
        if (broken) {
            throw new Error("the listing could not be read");
        }
        return { root: WORKSPACE_ROOT, tree: [], hidden: 0, barren: [], generation };
    };
    return {
        take,
        move: () => {
            generation += 1;
        },
        taken: () => taken,
        breakNext: (next: boolean) => {
            broken = next;
        },
    };
};

test("asks queued with no change between them share one view, the very answer each would have got", async () => {
    let open = (): void => {};
    const first = new Promise<void>((resolve) => (open = resolve));
    const tree = counted();
    const queue = viewQueue(first, tree.take, () => undefined);
    const asks = [queue.view(), queue.view(), queue.view()];
    open();
    const [answer, ...others] = await Promise.all(asks);
    expect(tree.taken()).toBe(1);
    expect(others.every((other) => other === answer)).toBe(true);
    // Nothing queued since: a later ask is still one of them.
    expect((await queue.view()) === answer).toBe(true);
    // Waiting on the line moves nothing either.
    await queue.settled();
    expect((await queue.view()) === answer).toBe(true);
    expect(tree.taken()).toBe(1);
});

test("an ask after a change is answered from the tree that change left, never from a view taken before it", async () => {
    const tree = counted();
    const queue = viewQueue(Promise.resolve(), tree.take, () => undefined);
    const before = queue.view();
    const moved = queue.change(tree.move);
    const after = queue.view();
    await moved;
    expect((await before).generation).toBe(0);
    expect((await after).generation).toBe(1);
    expect(tree.taken()).toBe(2);
    // A change queued after an ask does not reach back into it.
    const asked = queue.view();
    void queue.change(tree.move);
    expect((await asked).generation).toBe(1);
    expect((await queue.view()).generation).toBe(2);
});

test("a view that failed is not handed to the next ask", async () => {
    const failures: string[] = [];
    const tree = counted();
    const queue = viewQueue(Promise.resolve(), tree.take, (message) => failures.push(message));
    tree.breakNext(true);
    await expect(queue.view()).rejects.toThrow("the listing could not be read");
    tree.breakNext(false);
    expect((await queue.view()).generation).toBe(0);
    expect(tree.taken()).toBe(2);
    expect(failures).toEqual(["the listing could not be read"]);
});
