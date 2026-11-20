import { MARKER, MARKER_HEIGHT, MARKER_WIDTH, markerClock, paintMarker } from "../marker.js";

// The pages a run streams, one script for all four, picked by the page's address. Each paints the marker (marker.ts)
// into a canvas fixed at the viewport's top-left, in the same frame as the content it describes, so what the client
// reads off a decoded frame is exactly when that frame's content was drawn.
//
// - still: an article, the marker painted once. Nothing moves: what a pipeline spends here is overhead.
// - anim: the article under a box sliding 8 px a frame and the marker repainted every frame, at the display's 60 Hz.
// - scroll: a long article scrolled 6 px a frame, voxl's bench/scrolltarget.mjs, the marker fixed over it.
// - typing: a textarea; the marker carries the length of what was typed and when the page saw it, painted in the frame
//   the new glyph is.
// - flood: the whole viewport redrawn every frame, a dense text-like texture scrolling under a moving box (voxl's
//   bench/loadgen.c in a canvas) and confetti scattered anew each frame: more than a 5 Mbit/s link carries, so it is
//   the one that shows what a pipeline does when the link, not the page, is the limit.

const workload = location.pathname.split("/").pop() ?? "still";
const now = (): number => performance.timeOrigin + performance.now();

const markerCanvas = document.querySelector<HTMLCanvasElement>("#marker")!;
markerCanvas.width = MARKER_WIDTH;
markerCanvas.height = MARKER_HEIGHT;
Object.assign(markerCanvas.style, { position: "fixed", left: `${MARKER.x}px`, top: `${MARKER.y}px`, zIndex: "10" });
const markerContext = markerCanvas.getContext("2d")!;

const paint = (frame: number): void => {
    paintMarker(
        (x, y, size, white) => {
            markerContext.fillStyle = white ? "#ffffff" : "#000000";
            markerContext.fillRect(x, y, size, size);
        },
        { frame, ms: markerClock(now()) },
    );
};

const LOREM = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(" ");

// The same article every run: a seeded word sequence, so two runs encode the same pixels.
const article = (paragraphs: number): string => {
    let seed = 1;
    const next = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed;
    };
    const parts: string[] = [];
    for (let index = 0; index < paragraphs; index++) {
        if (index % 40 === 0) {
            parts.push(`<h2 style="background:hsl(${(index * 7) % 360},60%,85%)">Section ${index / 40}</h2><pre>fn main() { println!("hello ${index}"); }</pre>`);
        }
        const words = Array.from({ length: 8 + (next() % 24) }, () => LOREM[next() % LOREM.length]).join(" ");
        parts.push(`<p><b>${index}.</b> ${words}</p>`);
    }
    return parts.join("\n");
};

const content = document.querySelector<HTMLElement>("#content")!;

const still = (): void => {
    content.innerHTML = article(60);
    paint(0);
};

const anim = (): void => {
    content.innerHTML = article(60);
    const box = document.createElement("div");
    Object.assign(box.style, { position: "fixed", top: "40%", left: "0", width: "200px", height: "200px", background: "#e04040", zIndex: "5" });
    document.body.append(box);
    let frame = 0;
    const step = (): void => {
        frame += 1;
        box.style.transform = `translateX(${(frame * 8) % Math.max(1, innerWidth - 200)}px)`;
        box.style.background = `rgb(224, ${64 + (frame % 128)}, 64)`;
        paint(frame);
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
};

const scroll = (): void => {
    content.innerHTML = article(1500);
    let frame = 0;
    let direction = 1;
    const step = (): void => {
        frame += 1;
        window.scrollBy(0, 6 * direction);
        if (scrollY + innerHeight >= document.body.scrollHeight - 2 || scrollY <= 0) {
            direction = -direction;
        }
        paint(frame);
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
};

const flood = (): void => {
    const width = innerWidth;
    const height = innerHeight;
    // The "document": four viewports tall, drawn once with the same seed every run, lines of glyph-like marks.
    const texture = document.createElement("canvas");
    texture.width = width;
    texture.height = height * 4;
    const ink = texture.getContext("2d")!;
    ink.fillStyle = "#f5f5f5";
    ink.fillRect(0, 0, width, texture.height);
    let seed = 1;
    const next = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed;
    };
    for (let line = 0; line * 24 < texture.height; line++) {
        if (line % 17 === 0) {
            ink.fillStyle = "#3070d0";
            ink.fillRect(0, line * 24, width, 24);
            continue;
        }
        ink.fillStyle = ["#202020", "#402020", "#204020"][line % 3]!;
        const end = 40 + (next() % Math.max(1, width - 200));
        for (let x = 40; x < end; x += 9) {
            if (next() % 5 < 3) {
                ink.fillRect(x, line * 24 + 5, 7, 13);
            }
        }
    }
    const screen = document.createElement("canvas");
    screen.width = width;
    screen.height = height;
    Object.assign(screen.style, { position: "fixed", left: "0", top: "0", zIndex: "1" });
    document.body.append(screen);
    const draw = screen.getContext("2d")!;
    let frame = 0;
    const step = (): void => {
        frame += 1;
        draw.drawImage(texture, 0, (frame * 6) % (texture.height - height), width, height, 0, 0, width, height);
        draw.fillStyle = `rgb(224, ${64 + (frame % 128)}, 64)`;
        draw.fillRect((frame * 8) % Math.max(1, width - 200), height / 2 - 100, 200, 200);
        // Confetti no motion search can predict, scattered anew every frame: what makes this cost bits like video.
        for (let tile = 0; tile < 400; tile++) {
            draw.fillStyle = `rgb(${next() % 256}, ${next() % 256}, ${next() % 256})`;
            draw.fillRect(next() % width, next() % height, 24, 24);
        }
        paint(frame);
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
};

const typing = (): void => {
    const area = document.createElement("textarea");
    Object.assign(area.style, { position: "fixed", top: "80px", left: "16px", width: "calc(100% - 48px)", height: "calc(100% - 112px)", font: "28px/1.4 monospace" });
    area.spellcheck = false;
    document.body.append(area);
    area.focus();
    paint(0);
    area.addEventListener("input", () => paint(area.value.length));
};

switch (workload) {
    case "anim":
        anim();
        break;
    case "scroll":
        scroll();
        break;
    case "typing":
        typing();
        break;
    case "flood":
        flood();
        break;
    default:
        still();
}
document.documentElement.dataset["ready"] = "1";
