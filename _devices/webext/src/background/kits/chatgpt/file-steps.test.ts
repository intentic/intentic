import "@intentic/testing/dom";
import { CHATGPT_PAGE } from "@intentic/site-kits/chatgpt";
import { giveEveryElementABox, mountFakeChatgpt } from "@intentic/site-kits/chatgpt/testing";
import { pinFileInputStep } from "./file-steps.js";

// The extension's file step inside ChatGPT's page, against the kit's stand-in page (@intentic/site-kits).

beforeEach(() => {
    giveEveryElementABox();
});

test("the composer's own file input is held for the file, and a page without one is said plainly", () => {
    mountFakeChatgpt({ page: "home" });
    expect(pinFileInputStep(CHATGPT_PAGE.fileInput, "pin-1", "brief.pdf", "application/pdf")).toEqual({ kind: "answer", ok: true, message: "" });
    expect(window.intenticFilePin?.pin).toBe("pin-1");
    document.querySelector('input[type="file"]')?.remove();
    expect(pinFileInputStep(CHATGPT_PAGE.fileInput, "pin-2", "brief.pdf", "application/pdf")).toEqual({ kind: "answer", ok: false, message: "ChatGPT's page has no file input to attach to." });
    expect(window.intenticFilePin).toBeUndefined();
});
