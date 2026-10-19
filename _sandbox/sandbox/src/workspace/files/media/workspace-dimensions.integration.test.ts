import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { measurable, measure } from "./workspace-dimensions.js";

/* A gallery lays its rows out from every picture's box before any picture loads, so the box must be the one the
   picture is shown in: a phone photo's turn applied, an animation one frame tall, nothing for a file with no picture. */

const picture = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 40, g: 90, b: 200 } } });

test("measures a picture by its header, as it is shown", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-dims-"));
    const wide = join(root, "wide.png");
    const turned = join(root, "turned.jpg");
    await writeFile(wide, await picture(1600, 900).png().toBuffer());
    // Stored landscape with the EXIF turn a phone writes for a portrait shot (6: a quarter turn clockwise).
    await writeFile(turned, await picture(1200, 800).jpeg().withMetadata({ orientation: 6 }).toBuffer());

    expect(await measure([wide, turned])).toEqual([
        { width: 1600, height: 900 },
        { width: 800, height: 1200 },
    ]);
});

test("answers nothing for a file with no picture in it, and keeps the others' answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-dims-"));
    const good = join(root, "good.webp");
    const broken = join(root, "broken.png");
    await writeFile(good, await picture(300, 200).webp().toBuffer());
    await writeFile(broken, "this is not a png");

    expect(await measure([broken, join(root, "absent.png"), good])).toEqual([undefined, undefined, { width: 300, height: 200 }]);
});

test("measures pictures and videos, and leaves the rest and SVG markup to the reader", () => {
    expect(measurable("shots/a.PNG")).toBe(true);
    expect(measurable("film/cut.mp4")).toBe(true);
    expect(measurable("logo.svg")).toBe(false);
    expect(measurable("README.md")).toBe(false);
});
