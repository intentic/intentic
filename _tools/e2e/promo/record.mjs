// Records one take of the product's main journey against the real `@intentic/web` app, `_site/demo`'s fixture standing
// in for a sandbox; nothing is mocked or sped up. No reloads: the fixture is in-memory, so a reload rewinds the drop
// and the landed delta. The scripted turn starts on ATTACH, not page load, and parks until this script answers.

import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeDroppedRepo } from "./dropped-repo.mjs";

const HERE = import.meta.dirname;
const DEMO = process.env.DEMO_URL ?? "http://127.0.0.1:47146/demo";
const OUT = process.env.PROMO_OUT ?? "/tmp/intentic-promo";
const DROP_SOURCE = "/tmp/promo-drop/checkout-worker";

// Capture size must equal VIEWPORT with device scale 1: any mismatch misplaces the picture in the canvas.
const VIEWPORT = { width: 1760, height: 990 };
const DELIVERED = { width: 1920, height: 1080 };
const CHAT_WIDTH = 560;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Direction: a synthetic pointer and the chapter marks used for editing.

const pointer = { x: VIEWPORT.width - 60, y: 90 };
const chapters = [];
let clock = 0;

const chapter = (title, note) => {
    chapters.push({ ms: Date.now() - clock, title, note });
    console.log(`  ${new Date(Date.now() - clock).toISOString().slice(14, 22)}  ${title}`);
};

// Eases the flight so the pointer settles like a hand, not a linear slide.
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

// Settles before pressing so the click doesn't read as a jump cut, and re-aims first since the target can reflow
// mid-flight while the chat streams.
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

// Many small notches, not one big delta: a diff that jumps can't be read while scrolling.
const scroll = async (page, notches, { step = 90, pause = 26 } = {}) => {
    for (let index = 0; index < notches; index++) {
        await page.mouse.wheel(0, step);
        await sleep(pause);
    }
};

// The take: drop a repo, work the fleet, review and land, watch CI pick it up.

const record = async () => {
    const repo = writeDroppedRepo(DROP_SOURCE);
    rmSync(join(OUT, "raw"), { recursive: true, force: true });
    mkdirSync(join(OUT, "raw"), { recursive: true });

    // Full browser via channel: chromium, not the headless shell; this footage ships as-is.
    const browser = await chromium.launch({ channel: "chromium", args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, recordVideo: { dir: join(OUT, "raw"), size: VIEWPORT } });
    // Set before boot: useLayout reads ui-chat-width from localStorage at boot, not on resize.
    await context.addInitScript(`localStorage.setItem("ui-chat-width", "${CHAT_WIDTH}")`);
    await context.addInitScript({ content: readFileSync(join(HERE, "cursor.js"), "utf8") });

    const page = await context.newPage();
    const videoStartedAt = Date.now();
    page.on("pageerror", (error) => console.log(`  ! page error: ${String(error).slice(0, 160)}`));

    const chat = page.locator(".chat-panel");
    const board = page.locator("main");
    const railLink = (path) => page.locator(`a[href$="${path}"]`);
    const cardBody = (title) => board.locator("div.cursor-pointer").filter({ hasText: title }).first();
    // Targets the card's title, not its body: a Finished card's body centre carries its own Land now, while the title
    // only focuses the agent (opens chat, keeps the board).
    const card = (title) => cardBody(title).getByText(title).first();

    await page.goto(`${DEMO}/workspace`, { waitUntil: "domcontentloaded" });
    await page.getByRole("treeitem", { name: "README.md" }).waitFor({ timeout: 60_000 });
    await page.mouse.move(pointer.x, pointer.y);
    await sleep(1_600);
    clock = Date.now();

    // Drop the repo in: the dragged folder is a real directory, Chromium hands its FileSystemEntry roots,
    // collectDroppedFiles walks it. The ghost and pointer are only theatre over the app's own drop state.
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

    // The tree row appearing means the daemon has the files.
    await page.getByRole("treeitem", { name: "checkout-worker" }).waitFor({ timeout: 30_000 });
    await sleep(1_400);
    chapter("The repo lands in the tree", "uploaded, not indexed later: it is on the sandbox now");
    // Exact match: the tree has both a `checkout-worker` root and a `worker` file under `cmd`.
    const row = (name) => page.getByRole("treeitem", { name, exact: true });
    await click(page, row("checkout-worker"), { after: 700 });
    await click(page, row("cmd"), { after: 600 });
    await click(page, row("worker"), { after: 600 });
    await click(page, row("main.go"), { after: 2_400 });

    // Opening the card attaches to the run, so the stream starts exactly where the viewer is looking.
    chapter("Every agent on one board", "attention · active · finished");
    await click(page, railLink("/agents"), { after: 1_500 });
    await hover(page, card("Fix the flaky signup e2e test"), { dwell: 900 });
    await hover(page, card("Refactor the auth middlew"), { dwell: 900 });
    await sleep(400);

    chapter("Open the one that's running", "Stripe checkout, mid-turn");
    await click(page, card("Add Stripe checkout to the pricing page"), { after: 1_200 });

    // Approving happens with the whole plan open in the main view beside the chat.
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

    // Waits for the transcript to settle so opening the card doesn't fight the reflow. The card unfolds by its NAME;
    // the path beside it opens the file in the workspace instead.
    chapter("What it actually wrote", "every tool call keeps its diff");
    await glide(page, { x: 1_500, y: 500 }, 500);
    await scroll(page, 5, { step: -110 });
    await click(page, writeCard, { after: 3_000 });

    // The delta lives on its own branch until this press; that's why the board has a Finished lane, not a done toast.
    chapter("Back to the board", "one is finished and holding its work");
    await click(page, railLink("/agents"), { after: 1_400 });
    // Hover first: `Review & land` is a hover-reveal outside the attention lane, framing the next click.
    await hover(page, cardBody("Migrate the users table to soft deletes"), { dwell: 900 });
    await click(page, board.getByRole("button", { name: "Review & land" }), { after: 1_600, flight: 420 });

    chapter("Read the diff it wants to land", "file by file, on its own branch");
    // Wheel over the diff pane scrolls the review's file list, not the code, so glide there first.
    const overDiff = { x: 700, y: 520 };
    await glide(page, overDiff, 700);
    await scroll(page, 8);
    await sleep(1_100);
    await click(page, board.getByText("users.ts").first(), { after: 1_400 });
    await glide(page, overDiff, 500);
    await scroll(page, 7);
    await sleep(1_200);
    // Marks the file read from the diff toolbar's tick, not the list row's hover-reveal tick.
    const markRead = (file) => board.locator("section").getByRole("button", { name: new RegExp(`Mark .*${file} as reviewed`) });
    await click(page, markRead("users\\.ts"), { after: 900 });
    await click(page, board.getByText("schema.ts").first(), { after: 1_200 });
    await click(page, markRead("schema\\.ts"), { after: 900 });

    chapter("Land it", "the delta moves into the working tree");
    await click(page, page.getByRole("button", { name: "Land now" }), { after: 2_600 });

    chapter("Landed changes, with the agent on them", "the workspace's own Changes panel");
    await click(page, railLink("/workspace"), { after: 1_200 });
    await click(page, page.getByRole("tab", { name: /^Changes/ }), { after: 2_600 });

    // CI is the other half of the loop: the same branches, seen from the remote.
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

// Delivery: encode the master and write the chapter marks.

// Offset in the delivered file: chapter clock minus the head the encode trims.
const stamp = (ms) => {
    const total = Math.max(0, Math.round((ms - 700) / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const encode = ({ videoPath, startedAt }) => {
    const mp4 = join(OUT, "intentic-promo.mp4");
    // Trims the take's settling second and fades each end, leaving room for a voiceover.
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
