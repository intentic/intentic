import type { DraftSummary } from "@intentic/sandbox-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftEdit } from "./useDraftEdit";

/* Save-as-you-type, tested where losing a keystroke costs something. The debounce is real time, so it is faked
 * — what matters is not how long it waits but that nothing leaves the editor without the last words going with
 * it, and that reading a post never writes it. */

// A reply, which is what this queue is almost entirely made of: a URL target means no published headline, so
// `title` is the agent's note and the editor draws one box, not two.
const draft = (overrides: Partial<DraftSummary> = {}): DraftSummary => ({
    id: `d`,
    platform: `reddit`,
    target: `https://www.reddit.com/r/mcp/comments/1abc23/slug/`,
    content: `as written`,
    status: `proposed`,
    ...overrides,
});

let written: { draft: DraftSummary; changes: unknown }[];
const write = vi.fn(async (target: DraftSummary, changes: unknown) => void written.push({ draft: target, changes }));

beforeEach(() => {
    vi.useFakeTimers();
    written = [];
    write.mockClear();
});

describe("useDraftEdit", () => {
    it("writes after the typing stops, not on every keystroke", async () => {
        const edit = useDraftEdit(write);
        await edit.open(draft());
        edit.content.value = `re`;
        edit.touch();
        edit.content.value = `rewritten`;
        edit.touch();
        expect(write).not.toHaveBeenCalled();
        await vi.runAllTimersAsync();
        // One write, carrying the last thing typed rather than the first.
        expect(written).toHaveLength(1);
        expect(written[0]?.changes).toEqual({ content: `rewritten` });
    });

    // The gap between the last keystroke and the debounce is exactly where Approve lives.
    it("flushes on demand, so an approve cannot publish the word you just fixed", async () => {
        const edit = useDraftEdit(write);
        await edit.open(draft());
        edit.content.value = `fixed`;
        edit.touch();
        await edit.flush();
        expect(written[0]?.changes).toEqual({ content: `fixed` });
    });

    it("writes the last words on the way out, and on the way into another post", async () => {
        const edit = useDraftEdit(write);
        await edit.open(draft());
        edit.content.value = `closing`;
        edit.touch();
        await edit.close();
        expect(written).toHaveLength(1);

        await edit.open(draft({ id: `two` }));
        edit.content.value = `switching`;
        edit.touch();
        await edit.open(draft({ id: `three` }));
        expect(written).toHaveLength(2);
        expect(written[1]?.draft.id).toBe(`two`);
    });

    // Opening a post to re-read it before approving must not dirty the file — that is what makes a short
    // debounce safe, and what stops the queue flashing under someone who only looked.
    it("never writes when nothing changed", async () => {
        const edit = useDraftEdit(write);
        await edit.open(draft());
        edit.touch();
        await vi.runAllTimersAsync();
        await edit.close();
        expect(write).not.toHaveBeenCalled();
    });

    it("does not re-send a change it already wrote", async () => {
        const edit = useDraftEdit(write);
        await edit.open(draft());
        edit.content.value = `once`;
        await edit.flush();
        await edit.flush();
        await edit.close();
        expect(written).toHaveLength(1);
    });

    /* The count in the row's footer reads the FIELD while one is open — it is the fact that decides whether the
     * post can go out at all, so it has to move with the words rather than with the last save. */
    it("counts the words being typed, not the ones on disk", async () => {
        const edit = useDraftEdit(write);
        const target = draft();
        expect(edit.liveLength(target)).toBe(`as written`.length);
        await edit.open(target);
        edit.content.value = `much longer than before`;
        expect(edit.liveLength(target)).toBe(`much longer than before`.length);
        // A different row still reports its own.
        expect(edit.liveLength(draft({ id: `other`, content: `x` }))).toBe(1);
    });

    it("leaves a note the platform does not publish alone", async () => {
        // On a reply, `title` is the agent's note to the owner (postText.ts) and the editor draws no box for it.
        const edit = useDraftEdit(write);
        await edit.open(draft({ title: `why this reply` }));
        edit.content.value = `rewritten`;
        await edit.flush();
        expect(written[0]?.changes).not.toHaveProperty(`title`);
    });

    it("carries a published headline, and never blanks one", async () => {
        // A post with a real title, not a reply — the one shape where the editor draws a second box.
        const article = draft({ target: `r/webdev`, title: `Ship it on Friday` });
        const edit = useDraftEdit(write);
        await edit.open(article);
        edit.title.value = `Ship it on Monday`;
        await edit.flush();
        expect(written[0]?.changes).toMatchObject({ title: `Ship it on Monday` });

        // Selecting the headline to retype it empties the field for a moment. Saving THAT would leave a draft
        // that cannot post at all, so an emptied headline means unchanged.
        edit.title.value = ``;
        edit.content.value = `body moved on`;
        await edit.flush();
        expect(written[1]?.changes).toEqual({ content: `body moved on` });
    });
});
