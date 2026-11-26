import "@intentic/testing/dom";
import { giveEveryElementABox, mountFakeChatgpt } from "./fake-chatgpt.testing.js";
import { composeStep, inspectStep, lastAnswerStep, modeStep, personalizationStep, sendStep, watchStep } from "./steps.js";
import { type Baseline, installActing, installAsking, installReading, installWatching, type PageState } from "./page-hands.js";
import { CHATGPT_PAGE } from "./site.js";

// The kit's steps inside ChatGPT's page, against a stand-in shaped after a real snapshot of it (fake-chatgpt.testing.ts).
// jsdom runs no ChatGPT code, so this proves the kit drives a page that behaves the way ChatGPT was seen to (a rich
// editor, a Radix menu, a reply that arrives later), not that chatgpt.com still does.

const install = (): void => {
    installReading(CHATGPT_PAGE, location.host);
    installActing();
    installWatching();
    installAsking();
};

const state = (): PageState => {
    const seen = inspectStep();
    if (seen === null) {
        throw new Error("the helpers were not installed");
    }
    return seen;
};

const settled = { roundMs: 1000, settleMs: 30 };

const sendPrompt = async (prompt: string): Promise<Baseline> => {
    const before = state().counts;
    expect((await composeStep(prompt))?.ok).toBe(true);
    expect((await sendStep("button", 200))?.ok).toBe(true);
    return before;
};

beforeEach(() => {
    giveEveryElementABox();
    window.intenticChatgpt = undefined;
});

test("nothing is installed on a page that is not ChatGPT, so no step reads a site a redirect took the tab to", async () => {
    mountFakeChatgpt();
    install();
    expect(location.host).not.toBe("chatgpt.com");
    expect(installReading(CHATGPT_PAGE, "chatgpt.com")).toBe(false);
    expect(inspectStep()).toBeNull();
});

test("a step answers null until its helpers are installed, so the worker installs them and asks again", async () => {
    mountFakeChatgpt();
    expect(inspectStep()).toBeNull();
    expect(await composeStep("anything")).toBeNull();
    install();
    expect(state()).toMatchObject({ composer: true, signedOut: false, personalization: "personalized", generating: false });
});

test("a temporary chat is made unpersonalized through its menu, and the label read back says it took", async () => {
    const fake = mountFakeChatgpt();
    install();
    const set = await personalizationStep("unpersonalized", 300);
    expect(set).toMatchObject({ ok: true });
    expect(fake.personalization).toBe("unpersonalized");
    expect(state().personalization).toBe("unpersonalized");
    // The menu is closed again, so it does not sit over the message box.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // Asked again, nothing is pressed.
    expect(await personalizationStep("unpersonalized", 300)).toMatchObject({ ok: true, message: expect.stringContaining("already") });
});

test("when the button keeps its label, the menu is opened again and its checked choice is what confirms it", async () => {
    const fake = mountFakeChatgpt({ staticLabel: true });
    install();
    expect(await personalizationStep("unpersonalized", 300)).toMatchObject({ ok: true, message: expect.stringContaining("menu shows") });
    expect(fake.personalization).toBe("unpersonalized");
    expect(document.querySelector('[role="menu"]')).toBeNull();
});

test("a page without the Personalized menu is said plainly, so the worker can refuse to send", async () => {
    mountFakeChatgpt({ noPersonalization: true });
    install();
    expect(await personalizationStep("unpersonalized", 100)).toMatchObject({ ok: false, message: expect.stringContaining("not on the page") });
});

test("the prompt reaches the editor's own model through insertText, where textContent never would", async () => {
    const fake = mountFakeChatgpt();
    install();
    expect(await composeStep("Watercolor storyboard frame: a fox on a snowy bridge.")).toMatchObject({ ok: true });
    expect(fake.editorText()).toBe("Watercolor storyboard frame: a fox on a snowy bridge.");
});

test("without insertText, a paste is how the prompt gets in", async () => {
    const fake = mountFakeChatgpt({ execCommand: "missing" });
    install();
    expect(await composeStep("Ink sketch: a lighthouse in fog.")).toMatchObject({ ok: true });
    expect(fake.editorText()).toBe("Ink sketch: a lighthouse in fog.");
});

test("Send is pressed once it is enabled, and sending moves the page to the chat's own address", async () => {
    const routes: string[] = [];
    const fake = mountFakeChatgpt({ onRoute: (path) => routes.push(path) });
    install();
    await sendPrompt("Pixel art: a red kite over a harbor.");
    expect(fake.sent).toEqual(["Pixel art: a red kite over a harbor."]);
    expect(routes).toEqual([expect.stringMatching(/^\/c\//)]);
    expect(state().generating).toBe(true);
});

test("a finished image is found under its button, with its address and size, and ChatGPT's words beside it", async () => {
    mountFakeChatgpt({ replies: [{ kind: "image", src: "https://chatgpt.com/backend-api/estuary/content?id=file_1", text: "Here is your frame." }] });
    install();
    const before = await sendPrompt("Pixel art: a red kite over a harbor.");
    const watched = await watchStep(before, "Pixel art: a red kite over a harbor.", settled.roundMs, settled.settleMs);
    expect(watched).toMatchObject({
        outcome: "done",
        images: [{ src: "https://chatgpt.com/backend-api/estuary/content?id=file_1", width: 1672, height: 941 }],
        text: expect.stringContaining("Here is your frame."),
    });
});

test("while ChatGPT is still working, a round ends as working and says what the page shows", async () => {
    mountFakeChatgpt({ replies: [{ kind: "never" }] });
    install();
    const before = await sendPrompt("Pixel art: a red kite.");
    expect(await watchStep(before, "Pixel art: a red kite.", 150, settled.settleMs)).toMatchObject({ outcome: "working", hint: "Thinking" });
});

test("a refusal is answered with ChatGPT's own words instead of waiting out the call", async () => {
    const refusal = "I can't help create that image, because it would violate our content policy.";
    mountFakeChatgpt({ replies: [{ kind: "text", text: refusal }] });
    install();
    const before = await sendPrompt("Something it refuses.");
    expect(await watchStep(before, "Something it refuses.", settled.roundMs, settled.settleMs)).toMatchObject({ outcome: "failed", failure: refusal });
});

test("a usage limit shown as an alert is a failure with its text", async () => {
    mountFakeChatgpt({ replies: [{ kind: "alert", text: "You've reached your image generation limit. Your limit resets in 3 hours." }] });
    install();
    const before = await sendPrompt("A cat.");
    expect(await watchStep(before, "A cat.", settled.roundMs, settled.settleMs)).toMatchObject({ outcome: "failed", failure: expect.stringContaining("limit") });
});

test("a question back instead of an image is an answer, not a picture and not a hang", async () => {
    mountFakeChatgpt({ replies: [{ kind: "text", text: "Which aspect ratio would you like: square or wide?" }] });
    install();
    const before = await sendPrompt("A cat.");
    expect(await watchStep(before, "A cat.", settled.roundMs, settled.settleMs)).toMatchObject({ outcome: "answered", text: expect.stringContaining("aspect ratio") });
});

test("a prompt still sitting in the box is reported unsent, so the worker can press Enter once", async () => {
    mountFakeChatgpt({ deaf: true });
    install();
    const before = await sendPrompt("A cat.");
    expect(await watchStep(before, "A cat.", settled.roundMs, settled.settleMs)).toMatchObject({ outcome: "unsent" });
});

test("a Thinking label elsewhere on the page does not hold a quick refusal for the whole call", async () => {
    const refusal = "I can't create that image because it would violate our content policy.";
    mountFakeChatgpt({ leftoverThinking: true, replies: [{ kind: "text", text: refusal }] });
    install();
    const before = await sendPrompt("Something it refuses.");
    expect(await watchStep(before, "Something it refuses.", settled.roundMs, settled.settleMs)).toMatchObject({ outcome: "failed", failure: refusal });
});

test("a picture whose answer still shows a working line is not taken as done, since it may be a partial one", async () => {
    mountFakeChatgpt({ lingeringWork: true, replies: [{ kind: "image", src: "https://chatgpt.com/backend-api/estuary/content?id=file_1" }] });
    install();
    const before = await sendPrompt("A cat.");
    expect(await watchStep(before, "A cat.", 300, settled.settleMs)).toMatchObject({ outcome: "working", hint: "Creating image" });
});

test("judged as words, a finished answer is done, even one that says it can't help", async () => {
    const text = "I can't help with the legal side, but here is the summary you asked for.";
    mountFakeChatgpt({ replies: [{ kind: "text", text }] });
    install();
    const before = await sendPrompt("Summarize.");
    expect(await watchStep(before, "Summarize.", settled.roundMs, settled.settleMs, "text")).toMatchObject({ outcome: "done", text, images: [] });
});

test("an answer stopped at one of ChatGPT's own buttons ends the round as asking, Stop button and all, and nothing presses it", async () => {
    const fake = mountFakeChatgpt({ replies: [{ kind: "confirm", text: "About to search your Drive.", button: "Confirm" }] });
    install();
    const before = await sendPrompt("Find the deck.");
    expect(await watchStep(before, "Find the deck.", settled.roundMs, settled.settleMs, "text")).toMatchObject({ outcome: "asking", asks: "Confirm" });
    expect(state().generating).toBe(true);
    expect(fake.confirmed).toBe(false);
});

test("the last answer's baseline is the page as it stood before its prompt, so a read collects that answer alone", async () => {
    mountFakeChatgpt({ replies: [{ kind: "text", text: "First." }, { kind: "text", text: "Second." }] });
    install();
    const first = await sendPrompt("One.");
    await watchStep(first, "One.", settled.roundMs, settled.settleMs, "text");
    const second = await sendPrompt("Two.");
    await watchStep(second, "Two.", settled.roundMs, settled.settleMs, "text");
    const baseline = lastAnswerStep();
    expect(baseline).toEqual(second);
    expect(await watchStep(baseline ?? second, "", settled.roundMs, settled.settleMs, "text")).toMatchObject({ outcome: "done", text: "Second." });
});

test("a tool is chosen from the composer's menu and shows as a pill; one the account lacks is said plainly", async () => {
    const fake = mountFakeChatgpt({ page: "home" });
    install();
    expect(await modeStep("deep_research", 300)).toEqual({ kind: "answer", ok: true, message: "It shows as chosen." });
    expect(fake.mode).toBe("Deep research");
    expect(await modeStep("deep_research", 300)).toEqual({ kind: "answer", ok: true, message: "It already shows as chosen." });
    mountFakeChatgpt({ page: "home", noTools: true });
    install();
    expect(await modeStep("agent", 100)).toMatchObject({ ok: false, message: expect.stringContaining("has no") });
    expect(document.querySelector('[role="menu"]')).toBeNull();
});
