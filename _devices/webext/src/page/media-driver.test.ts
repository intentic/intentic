import "@intentic/testing/dom";
import { renderPage, toPageState } from "@intentic/browser/page";
import { collectPage } from "./driver.js";
import { dropStaged, findFileInput, mediaOfRef, putFile, readStaged, receiveFileSlice, stageMedia } from "./media-driver.js";

// The page half of moving files between a page and the sandbox, against jsdom: which pictures a snapshot lists and how
// big, what a ref resolves to as something to fetch, which file input a button stands for, and a file put into one.
// jsdom lays nothing out, so each element's box is stubbed: 400×300 unless it carries data-w/data-h.

beforeEach(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
        const width = Number(this.getAttribute("data-w") ?? 400);
        const height = Number(this.getAttribute("data-h") ?? 300);
        return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
    };
    document.body.innerHTML = "";
});

const natural = (img: Element | null, width: number, height: number): void => {
    Object.defineProperty(img, "naturalWidth", { value: width });
    Object.defineProperty(img, "naturalHeight", { value: height });
};

test("a snapshot lists the pictures a person sees, with their own size, and leaves icons and decoration out", () => {
    document.body.innerHTML = `
        <button aria-label="Generated image 1"><img id="big" alt="Generated image 1" src="https://chatgpt.com/backend-api/estuary/content?id=1" /></button>
        <img alt="avatar" src="/me.png" data-w="32" data-h="32" />
        <img alt="" src="/divider.png" />
        <img aria-hidden="true" src="/glow.png" />
        <video src="/clip.mp4"></video>
        <audio src="/song.mp3"></audio>`;
    natural(document.getElementById("big"), 1672, 941);
    const page = collectPage();
    const rendered = renderPage(toPageState(page), page.truncated);
    expect(rendered).toContain(`[e0] button "Generated image 1"`);
    expect(rendered).toContain(`[e1] img "Generated image 1" 1672×941`);
    // A video that has not loaded yet is listed as drawn.
    expect(rendered).toContain(`[e2] video 400×300`);
    expect(rendered).not.toContain("avatar");
    expect(page.elements.filter((element) => element.role === "img")).toHaveLength(1);
    // A sound with no player showing is nothing a person sees.
    expect(rendered).not.toContain("audio");
});

test("a sidebar that fills the list does not hide the picture the agent came for", () => {
    const links = Array.from({ length: 160 }, (_unused, index) => `<a href="/c/${index}">Chat ${index}</a>`).join("");
    document.body.innerHTML = `<nav>${links}</nav><main><img alt="Generated image 1" src="/g.png" /></main>`;
    const page = collectPage();
    expect(page.truncated).toBe(true);
    expect(page.elements).toHaveLength(151);
    expect(page.elements.at(-1)).toMatchObject({ role: "img", name: "Generated image 1", size: "400×300" });
});

test("a ref resolves to the media it shows: the picture itself, the one inside a button, a download link, a background", async () => {
    document.body.innerHTML = `
        <img id="a" alt="Cat" src="/cat.png" />
        <button><span>Generated image 1</span><img alt="small" src="/thumb.png" data-w="40" data-h="40" /><img alt="big" src="/full.png" data-w="800" data-h="600" /></button>
        <a href="/report.pdf" download>Report</a>
        <div role="img" aria-label="Hero" style="background-image: url('/hero.jpg')">Hero</div>
        <button>Nothing here</button>`;
    collectPage();
    const refOf = (name: string): string => `e${(window.intenticPageRefs ?? []).findIndex((el) => el.getAttribute("alt") === name || el.textContent?.trim() === name || el.getAttribute("aria-label") === name)}`;
    expect(await mediaOfRef(refOf("Cat"))).toMatchObject({ ok: true, url: `${location.origin}/cat.png`, kind: "image", name: "Cat" });
    expect(await mediaOfRef(refOf("Generated image 1"))).toMatchObject({ ok: true, url: `${location.origin}/full.png`, name: "big" });
    expect(await mediaOfRef(refOf("Report"))).toMatchObject({ ok: true, url: `${location.origin}/report.pdf`, kind: "file" });
    expect(await mediaOfRef(refOf("Hero"))).toMatchObject({ ok: true, url: `${location.origin}/hero.jpg` });
    const none = await mediaOfRef(refOf("Nothing here"));
    expect(none.ok).toBe(false);
    expect(none.message).toContain("holds no picture");
    expect((await mediaOfRef("e99")).message).toContain("fresh snapshot");
});

test("a fetched file is held in the page and read out in slices, refused past the cap or on an error status", async () => {
    const realFetch = globalThis.fetch;
    const bytes = Uint8Array.from({ length: 10 }, (_unused, index) => index);
    globalThis.fetch = Object.assign(
        async (url: string | URL | Request) =>
            String(url).endsWith("/gone")
                ? new Response("no", { status: 403 })
                : String(url).endsWith("/export")
                  ? new Response(bytes, { status: 200, headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="export.csv"` } })
                  : new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }),
        { preconnect: realFetch.preconnect },
    );
    try {
        expect(await stageMedia(`${location.origin}/a.png`, "slot-1", 1000)).toEqual({ ok: true, bytes: 10, type: "image/png", attachment: false, message: "" });
        const first = await readStaged("slot-1", 0, 6);
        const second = await readStaged("slot-1", 6, 6);
        expect([...atob(first.data) + atob(second.data)].map((char) => char.charCodeAt(0))).toEqual([...bytes]);
        // Another call's slot reads nothing.
        expect((await readStaged("slot-2", 0, 6)).ok).toBe(false);
        dropStaged("slot-1");
        expect((await readStaged("slot-1", 0, 6)).ok).toBe(false);
        expect(await stageMedia(`${location.origin}/a.png`, "slot-3", 5)).toMatchObject({ ok: false, reason: "refused" });
        const gone = await stageMedia(`${location.origin}/gone`, "slot-4", 1000);
        expect(gone).toMatchObject({ ok: false, reason: "refused" });
        expect(gone.message).toContain("403");
        // A download the site hands out says so, for the worker's keptFromAddress.
        expect(await stageMedia(`${location.origin}/export`, "slot-5", 1000)).toMatchObject({ ok: true, type: "text/csv", attachment: true });
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("the button that opens the file chooser stands for the input beside it that takes this file", () => {
    document.body.innerHTML = `
        <form>
            <input type="file" id="docs" accept=".pdf" hidden />
            <input type="file" id="pics" accept="image/*" hidden />
            <button type="button">Add files and more</button>
        </form>`;
    collectPage();
    const refs = window.intenticPageRefs ?? [];
    const add = `e${refs.findIndex((el) => el.textContent === "Add files and more")}`;
    expect(findFileInput(add, "pin-1", "frame.png", "image/png")).toEqual({ ok: true, message: "" });
    expect(window.intenticFilePin?.input.id).toBe("pics");
    expect(findFileInput(add, "pin-2", "song.mp3", "audio/mpeg").message).toContain("takes only");
});

test("the file goes into the input held for it, with the events a page listens for, and never into one that left", () => {
    // jsdom has no DataTransfer; this one hands back what was added, which the input below accepts as its files.
    class FakeTransfer {
        readonly added: File[] = [];
        readonly items = { add: (file: File) => this.added.push(file) };
        get files(): File[] {
            return this.added;
        }
    }
    Object.assign(globalThis, { DataTransfer: FakeTransfer });
    document.body.innerHTML = `<input type="file" id="f" />`;
    const input = document.getElementById("f");
    if (!(input instanceof HTMLInputElement)) {
        throw new Error("no input");
    }
    let files: File[] = [];
    Object.defineProperty(input, "files", {
        get: () => files,
        set: (value: File[]) => {
            files = value;
        },
    });
    const events: string[] = [];
    for (const name of ["input", "change"]) {
        input.addEventListener(name, () => events.push(name));
    }
    collectPage();
    expect(findFileInput("e0", "pin", "frame.png", "image/png").ok).toBe(true);
    receiveFileSlice("pin", btoa("PNG"));
    receiveFileSlice("pin", btoa("DATA"));
    expect(putFile("pin", "frame.png", "image/png")).toEqual({ ok: true, message: "attached" });
    expect(files.map((file) => [file.name, file.type, file.size])).toEqual([["frame.png", "image/png", 7]]);
    expect(events).toEqual(["input", "change"]);

    // Held, then gone from the page while the person decided.
    expect(findFileInput("e0", "pin-2", "frame.png", "image/png").ok).toBe(true);
    input.remove();
    expect(putFile("pin-2", "frame.png", "image/png").ok).toBe(false);
});
