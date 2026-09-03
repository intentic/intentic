/* THE PROMO RECORDING: one unbroken take of the product's main journey, driven against the interactive demo.
 *
 * What it records is the real `@intentic-app/web` app (`_site/demo` boots it against a fixture instead of a
 * sandbox), so every frame below is the shipping UI reacting to the shipping protocol: the drop really walks a
 * directory and writes it, the streaming turn is `AgentEvent` frames the chat has never seen before, the land is
 * the mutation that moves four surfaces at once. Nothing is mocked up for marketing, and nothing is sped up.
 *
 *   pnpm -C _site/demo dev          # the fixture app on :47146
 *   node promo/record.mjs           # from _tools/e2e: writes the mp4 + its chapter marks
 *
 * Two things the take depends on, both of them load-bearing:
 *   · NO RELOADS. The fixture is in-memory, so a reload rewinds the dropped repo and the landed delta. Every
 *     move after the first goto is an in-app click, exactly as a visitor's would be.
 *   · The scripted turn starts on ATTACH, not on page load: opening the agent is what starts it, and it parks
 *     on its plan and its question until this script answers. The pauses below are therefore direction, not
 *     synchronisation: the turn waits for the pointer.
 */

import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeDroppedRepo } from "./dropped-repo.mjs";

const HERE = import.meta.dirname;
const DEMO = process.env.DEMO_URL ?? "http://127.0.0.1:47146/demo";
const OUT = process.env.PROMO_OUT ?? "/tmp/intentic-promo";
const DROP_SOURCE = "/tmp/promo-drop/checkout-worker";

/* CAPTURE SIZE MUST EQUAL THE VIEWPORT, and the device scale must be 1. Every other combination measured here
 * misplaces the picture inside the canvas rather than filling it: a 1920×1080 canvas with dsf 2 records the app
 * at quarter size in the corner, and a 2× canvas either letterboxes it or lays the page out at the canvas width.
 * So the take is captured 1:1 and ffmpeg resolves it to 1080p: a 1.09× lift, small enough to stay clean.
 *
 * 1760 CSS px is the layout: three fleet lanes carrying their titles unclipped beside a chat wide enough to read
 * a streaming turn, and every element lands ~9% larger on the delivered frame than a native 1080p capture. */
const VIEWPORT = { width: 1760, height: 990 };
const DELIVERED = { width: 1920, height: 1080 };
const CHAT_WIDTH = 560;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- direction: a pointer that moves like a hand, and marks for the edit ---------- */

const pointer = { x: VIEWPORT.width - 60, y: 90 };
const chapters = [];
let clock = 0;

const chapter = (title, note) => {
    chapters.push({ ms: Date.now() - clock, title, note });
    console.log(`  ${new Date(Date.now() - clock).toISOString().slice(14, 22)}  ${title}`);
};

// Ease-in-out over a short flight so the pointer accelerates away and settles rather than sliding at one speed:
// the difference between "a script is moving this" and "someone is using this".
const glide = async (page, to, ms = 620) => {
    const from = { ...pointer };
    const steps = Math.max(8, Math.round(ms / 16));
    for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        await page.mouse.move(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased);
        await sleep(ms / steps);
    }
    pointer.x = to.x;
    pointer.y = to.y;
};

const centreOf = async (locator, timeout = 30_000) => {
    await locator.waitFor({ state: "visible", timeout });
    const box = await locator.boundingBox();
    if (box === null) {
        throw new Error(`No box for ${locator}`);
    }
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
};

// Move, settle, press. The settle is what makes a click readable: a pointer that arrives and fires in the same
// frame reads as a jump cut, and a viewer never sees what was pressed.
//
// The re-aim before pressing is not politeness: a streaming chat reflows under the pointer while it is still in
// flight, so the box measured at the start of the glide can be a card and a half stale by the time it lands. It
// shows up as a small correction, which is also what a hand does.
const click = async (page, locator, { settle = 260, after = 500, flight = 620 } = {}) => {
    await glide(page, await centreOf(locator), flight);
    const settled = await centreOf(locator);
    if (Math.abs(settled.x - pointer.x) > 6 || Math.abs(settled.y - pointer.y) > 6) {
        await glide(page, settled, 180);
    }
    await sleep(settle);
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
    await sleep(after);
};

const hover = async (page, locator, { flight = 620, dwell = 900 } = {}) => {
    await glide(page, await centreOf(locator), flight);
    await sleep(dwell);
};

// Wheel in many small notches: one big delta jumps, and a diff that jumps can't be read.
const scroll = async (page, notches, { step = 90, pause = 26 } = {}) => {
    for (let index = 0; index < notches; index++) {
        await page.mouse.wheel(0, step);
        await sleep(pause);
    }
};

/* ---------- the take ---------- */

const record = async () => {
    const repo = writeDroppedRepo(DROP_SOURCE);
    rmSync(join(OUT, "raw"), { recursive: true, force: true });
    mkdirSync(join(OUT, "raw"), { recursive: true });

    // `channel: chromium` is the full baked browser rather than the headless shell (../playwright.config.ts
    // carries the reasoning), and it matters more here than anywhere: this take is the picture people watch.
    const browser = await chromium.launch({ channel: "chromium", args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, recordVideo: { dir: join(OUT, "raw"), size: VIEWPORT } });
    // A chat wide enough to read a streaming turn from across a room: the panel is drag-resizable, so this is a
    // stored preference, not a special build. Written before the app boots, which is when useLayout reads it.
    await context.addInitScript(`localStorage.setItem("ui-chat-width", "${CHAT_WIDTH}")`);
    await context.addInitScript({ content: readFileSync(join(HERE, "cursor.js"), "utf8") });

    const page = await context.newPage();
    const videoStartedAt = Date.now();
    page.on("pageerror", (error) => console.log(`  ! page error: ${String(error).slice(0, 160)}`));

    const chat = page.locator(".chat-panel");
    const board = page.locator("main");
    const railLink = (path) => page.locator(`a[href$="${path}"]`);
    const cardBody = (title) => board.locator("div.cursor-pointer").filter({ hasText: title }).first();
    // The card's TITLE, not the card's middle: a Finished card carries its own "Land now" there, and a press
    // aimed at the centre lands the agent straight from the board. A press on the card FOCUSES the agent (its
    // chat opens beside the board, which stays); the view-change is the card's own hover CTA, clicked below.
    const card = (title) => cardBody(title).getByText(title).first();

    await page.goto(`${DEMO}/workspace`, { waitUntil: "domcontentloaded" });
    await page.getByRole("treeitem", { name: "README.md" }).waitFor({ timeout: 60_000 });
    await page.mouse.move(pointer.x, pointer.y);
    await sleep(1_600);
    clock = Date.now();

    /* 1, DROP THE REPOS IN. The dragged folder is a real directory on disk: Chromium hands the page its
     * FileSystemEntry roots, `collectDroppedFiles` walks it, and the queue uploads what it finds. The ghost and
     * the pointer are the only theatre: the highlight under them is the app's own drop state. */
    chapter("Drop a repository in", "the workspace, before any agent");
    const zone = await centreOf(page.getByText("Drop your work here"));
    const cdp = await context.newCDPSession(page);
    const payload = { items: [], files: [repo.dir], dragOperationsMask: 1 };
    const entry = { x: VIEWPORT.width - 120, y: 120 };

    await glide(page, entry, 300);
    await page.evaluate(([label, count]) => window.promoDragGhost(label, count), ["checkout-worker", `${repo.files} files`]);
    await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...entry, data: payload });

    const legs = 26;
    for (let leg = 1; leg <= legs; leg++) {
        const t = leg / legs;
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const at = { x: Math.round(entry.x + (zone.x - entry.x) * eased), y: Math.round(entry.y + (zone.y - entry.y) * eased) };
        await page.mouse.move(at.x, at.y);
        await cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...at, data: payload });
        await sleep(46);
    }
    pointer.x = zone.x;
    pointer.y = zone.y;
    await sleep(420);
    await cdp.send("Input.dispatchDragEvent", { type: "drop", ...zone, data: payload });
    await page.evaluate(() => window.promoDragGhost());

    // The tree row is the acknowledgement that matters: the daemon has the files.
    await page.getByRole("treeitem", { name: "checkout-worker" }).waitFor({ timeout: 30_000 });
    await sleep(1_400);
    chapter("The repo lands in the tree", "uploaded, not indexed later: it is on the sandbox now");
    // Exact names throughout: the dropped tree has a `worker` under `cmd` AND is itself `checkout-worker`.
    const row = (name) => page.getByRole("treeitem", { name, exact: true });
    await click(page, row("checkout-worker"), { after: 700 });
    await click(page, row("cmd"), { after: 600 });
    await click(page, row("worker"), { after: 600 });
    await click(page, row("main.go"), { after: 2_400 });

    /* 2: THE FLEET, AND ONE TURN INSIDE IT. Opening the card is what attaches to the run, so the stream that
     * follows starts where the viewer is looking. */
    chapter("Every agent on one board", "attention · active · finished");
    await click(page, railLink("/agents"), { after: 1_500 });
    await hover(page, card("Fix the flaky signup e2e test"), { dwell: 900 });
    await hover(page, card("Refactor the auth middlew"), { dwell: 900 });
    await sleep(400);

    chapter("Open the one that's running", "Stripe checkout, mid-turn");
    await click(page, card("Add Stripe checkout to the pricing page"), { after: 1_200 });

    // The plan card parks the turn and the app opens the plan document in the main view beside it: approving is
    // a decision taken with the whole plan on screen, which is the point of raising it as a card at all.
    const approve = chat.getByRole("button", { name: "Yes, and auto-accept edits" });
    await approve.waitFor({ timeout: 60_000 });
    chapter("It asks before it edits", "the plan opens in the main view");
    await sleep(2_600);
    await click(page, approve, { after: 900 });

    chapter("Approved: it works", "todos tick, tools resolve, the context meter moves");
    const writeCard = chat.getByRole("button", { name: "Write", exact: true });
    await writeCard.waitFor({ timeout: 60_000 });
    await sleep(4_200);

    const option = chat.getByRole("button", { name: /Inline spinner/ });
    await option.waitFor({ timeout: 60_000 });
    chapter("And it asks you the design question", "not a silent guess");
    await sleep(2_200);
    await click(page, option, { after: 700 });
    await click(page, chat.getByRole("button", { name: "Submit" }), { after: 3_200 });

    /* The turn has settled, so the transcript stops moving and a card can be opened without the reflow stealing
     * the press. Unfolded by its NAME, which is the fold toggle: the path beside it is a different control
     * ("open in workspace"), and pressing that one replaces the plan in the main view with the file. */
    chapter("What it actually wrote", "every tool call keeps its diff");
    await glide(page, { x: 1_500, y: 500 }, 500);
    await scroll(page, 5, { step: -110 });
    await click(page, writeCard, { after: 3_000 });

    /* 3: REVIEW, THEN LAND. The agent's delta lives on its own branch until this press; the press is the whole
     * reason the board has a Finished lane rather than a "done" toast. */
    chapter("Back to the board", "one is finished and holding its work");
    await click(page, railLink("/agents"), { after: 1_400 });
    // Hover first: the card's "Review & land" CTA is a hover-reveal everywhere except the attention lane, and it
    // appearing under the pointer is the frame that explains where the next click goes.
    await hover(page, cardBody("Migrate the users table to soft deletes"), { dwell: 900 });
    await click(page, board.getByRole("button", { name: "Review & land" }), { after: 1_600, flight: 420 });

    chapter("Read the diff it wants to land", "file by file, on its own branch");
    // Over the diff pane before the wheel turns: the review list is its own scroller, and a wheel over that one
    // nudges four file rows instead of moving the code.
    const overDiff = { x: 700, y: 520 };
    await glide(page, overDiff, 700);
    await scroll(page, 8);
    await sleep(1_100);
    await click(page, board.getByText("users.ts").first(), { after: 1_400 });
    await glide(page, overDiff, 500);
    await scroll(page, 7);
    await sleep(1_200);
    // The tick in the DIFF toolbar, not the one on the list row: it marks the file you have just read, which is
    // the gesture being demonstrated (and the list's own tick is a hover-reveal that the pointer isn't near).
    const markRead = (file) => board.locator("section").getByRole("button", { name: new RegExp(`Mark .*${file} as reviewed`) });
    await click(page, markRead("users\\.ts"), { after: 900 });
    await click(page, board.getByText("schema.ts").first(), { after: 1_200 });
    await click(page, markRead("schema\\.ts"), { after: 900 });

    chapter("Land it", "the delta moves into the working tree");
    await click(page, page.getByRole("button", { name: "Land now" }), { after: 2_600 });

    chapter("Landed changes, with the agent on them", "the workspace's own Changes panel");
    await click(page, railLink("/workspace"), { after: 1_200 });
    await click(page, page.getByRole("tab", { name: /^Changes/ }), { after: 2_600 });

    /* 4, WHAT CI DID WITH IT. The board is the other half of the loop: the same branches, seen from the remote. */
    chapter("And CI is already on it", "runs from the repos' GitHub and GitLab remotes");
    await click(page, railLink("/ext/pipelines"), { after: 2_000 });
    await hover(page, page.getByRole("button", { name: "Fix with agent" }).first(), { dwell: 1_800 });

    chapter("Close on the fleet", "hold for the outro");
    await click(page, railLink("/agents"), { after: 3_400 });

    const videoPath = await page.video().path();
    const startedAt = clock - videoStartedAt;
    await context.close();
    await browser.close();
    return { videoPath, startedAt };
};

/* ---------- delivery: an editable master, and the marks to cut voice against ---------- */

// A beat's offset in the DELIVERED file: the take's clock minus the head the encode trims off it.
const stamp = (ms) => {
    const total = Math.max(0, Math.round((ms - 700) / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const encode = ({ videoPath, startedAt }) => {
    const mp4 = join(OUT, "intentic-promo.mp4");
    // Trim to just before the first beat (the take's own settling second is not the film), then a short fade at
    // each end so a voiceover has somewhere to start and land.
    const head = Math.max(0, startedAt - 700) / 1000;
    const duration = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath]).toString().trim();
    const body = Number(duration) - head;
    execFileSync("ffmpeg", [
        "-y",
        "-ss",
        head.toFixed(3),
        "-i",
        videoPath,
        "-vf",
        `scale=${DELIVERED.width}:${DELIVERED.height}:flags=lanczos,fade=t=in:st=0:d=0.5,fade=t=out:st=${(body - 0.8).toFixed(2)}:d=0.8`,
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "18",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        mp4,
    ]);

    const marks = [
        "# intentic promo: shot list",
        "",
        "Recorded from the interactive demo (`_site/demo`), which runs the real web app against a fixture.",
        "Silent 1080p30 master: `intentic-promo.mp4`. Times are where each beat STARTS.",
        "",
        "| Time | On screen | What it is |",
        "| --- | --- | --- |",
        ...chapters.map((entry) => `| ${stamp(entry.ms)} | ${entry.title} | ${entry.note} |`),
        "",
    ].join("\n");
    writeFileSync(join(OUT, "shot-list.md"), marks);
    return mp4;
};

const take = await record();
const mp4 = encode(take);
console.log(`\n  master: ${mp4}\n  marks:  ${join(OUT, "shot-list.md")}\n  raw:    ${take.videoPath}`);
