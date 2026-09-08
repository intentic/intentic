import type { PostApprovalSummary } from "@intentic/sandbox-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePostEdit } from "./usePostEdit";

// Save-as-you-type; the debounce is faked. What matters: nothing leaves without the last keystroke, and reading a post
// never writes it.

// A reply (URL target): no published headline, so `title` is the agent's note and the editor draws one box, not two.
const post = (overrides: Partial<PostApprovalSummary> = {}): PostApprovalSummary => ({
    id: `d`,
    kind: `post`,
    platform: `reddit`,
    target: `https://www.reddit.com/r/mcp/comments/1abc23/slug/`,
    content: `as written`,
    status: `proposed`,
    ...overrides,
});

let written: { post: PostApprovalSummary; changes: unknown }[];
const write = vi.fn(async (target: PostApprovalSummary, changes: unknown) => void written.push({ post: target, changes }));

beforeEach(() => {
    vi.useFakeTimers();
    written = [];
    write.mockClear();
});

describe("usePostEdit", () => {
    it("writes after the typing stops, not on every keystroke", async () => {
        const edit = usePostEdit(write);
        await edit.open(post());
        edit.content.value = `re`;
        edit.touch();
        edit.content.value = `rewritten`;
        edit.touch();
        expect(write).not.toHaveBeenCalled();
        await vi.runAllTimersAsync();
        // One write, the last value typed, not the first.
        expect(written).toHaveLength(1);
        expect(written[0]?.changes).toEqual({ content: `rewritten` });
    });

    // The gap between the last keystroke and the debounce is exactly where Approve lives.
    it("flushes on demand, so an approve cannot publish the word you just fixed", async () => {
        const edit = usePostEdit(write);
        await edit.open(post());
        edit.content.value = `fixed`;
        edit.touch();
        await edit.flush();
        expect(written[0]?.changes).toEqual({ content: `fixed` });
    });

    it("writes the last words on the way out, and on the way into another post", async () => {
        const edit = usePostEdit(write);
        await edit.open(post());
        edit.content.value = `closing`;
        edit.touch();
        await edit.close();
        expect(written).toHaveLength(1);

        await edit.open(post({ id: `two` }));
        edit.content.value = `switching`;
        edit.touch();
        await edit.open(post({ id: `three` }));
        expect(written).toHaveLength(2);
        expect(written[1]?.post.id).toBe(`two`);
    });

    // Opening a post to read it must not dirty the file, or a short debounce would flash the queue under someone who
    // only looked.
    it("never writes when nothing changed", async () => {
        const edit = usePostEdit(write);
        await edit.open(post());
        edit.touch();
        await vi.runAllTimersAsync();
        await edit.close();
        expect(write).not.toHaveBeenCalled();
    });

    it("does not re-send a change it already wrote", async () => {
        const edit = usePostEdit(write);
        await edit.open(post());
        edit.content.value = `once`;
        await edit.flush();
        await edit.flush();
        await edit.close();
        expect(written).toHaveLength(1);
    });

    // The footer's count reads the live field, not the last save, since it decides whether the post can go out at all.
    it("counts the words being typed, not the ones on disk", async () => {
        const edit = usePostEdit(write);
        const target = post();
        expect(edit.liveLength(target)).toBe(`as written`.length);
        await edit.open(target);
        edit.content.value = `much longer than before`;
        expect(edit.liveLength(target)).toBe(`much longer than before`.length);
        // A different row still reports its own.
        expect(edit.liveLength(post({ id: `other`, content: `x` }))).toBe(1);
    });

    it("leaves a note the platform does not publish alone", async () => {
        // On a reply, `title` is the agent's own note (postText.ts), not a headline.
        const edit = usePostEdit(write);
        await edit.open(post({ title: `why this reply` }));
        edit.content.value = `rewritten`;
        await edit.flush();
        expect(written[0]?.changes).not.toHaveProperty(`title`);
    });

    it("carries a published headline, and never blanks one", async () => {
        // A titled, non-reply post: the shape where the editor draws a second box.
        const article = post({ target: `r/webdev`, title: `Ship it on Friday` });
        const edit = usePostEdit(write);
        await edit.open(article);
        edit.title.value = `Ship it on Monday`;
        await edit.flush();
        expect(written[0]?.changes).toMatchObject({ title: `Ship it on Monday` });

        // Selecting the headline to retype it empties the field for a moment; saving that would leave a post that can't
        // go out, so an emptied headline means unchanged.
        edit.title.value = ``;
        edit.content.value = `body moved on`;
        await edit.flush();
        expect(written[1]?.changes).toEqual({ content: `body moved on` });
    });

    // An action row has no pencil, but the page still asks if it's the one open; the answer is always no.
    it("is never editing an action", async () => {
        const edit = usePostEdit(write);
        await edit.open(post());
        expect(edit.isEditing({ id: `d`, kind: `action`, summary: `s`, instructions: `i`, status: `proposed` })).toBe(true);
        expect(edit.isEditing({ id: `other`, kind: `action`, summary: `s`, instructions: `i`, status: `proposed` })).toBe(false);
    });
});
