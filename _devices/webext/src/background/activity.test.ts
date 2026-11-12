import { describeCall } from "./activity.js";

// The popup's activity list reads the file tools as sentences, never as their raw arguments.

test("the file tools read as sentences, and upload_file's ticket never reaches the list", () => {
    expect(describeCall("save_media", { ref: "e129" })).toBe("Saved e129 into its sandbox");
    expect(describeCall("save_media", { url: "https://chatgpt.com/backend-api/estuary/content?id=1&sig=abc" })).toBe(
        "Saved chatgpt.com/backend-api/estuary/content into its sandbox",
    );
    expect(describeCall("save_media", { url: "blob:https://chatgpt.com/0d9c" })).toBe("Saved a file the page made into its sandbox");
    const upload = describeCall("upload_file", { ref: "e3", path: "/shelf/chrome/frame.png", ticket: "tkt-secret" });
    expect(upload).toBe("Attached “frame.png” from its sandbox to e3");
    expect(upload).not.toContain("tkt-secret");
    expect(describeCall("chatgpt_image", { prompt: "Watercolor storyboard frame: a fox crossing a snowy bridge at dusk.", chat: "abc" })).toMatch(
        /^Asked ChatGPT for an image: “Watercolor storyboard frame/u,
    );
});
