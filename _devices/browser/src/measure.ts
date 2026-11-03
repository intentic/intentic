import { fitSize, type ImageLimits, MODEL_IMAGE_LIMITS } from "@intentic/base/image-fit";
import type { CdpSession } from "./cdp.js";
import { type FramesOptions, type RawFrames, STALL_MS } from "./frames.js";
import { BrowserError, BrowserTimeoutError, type PageShot } from "./types.js";

// What the agent learns from a page beyond its elements: a picture of it as its GPU composited it, the value of a script
// run in it, and its frame timing. Each takes the session it works through, so a test hands it a scripted one.

// The most of an evaluated value's JSON an answer carries; beyond it the answer says how much it left out.
const MAX_VALUE_TEXT = 20_000;
// What the browser needs past a script's own deadline to say it ended, before the call is given up on.
const ANSWER_MARGIN_MS = 5000;

// The subset of Runtime.evaluate's answer read here.
interface Evaluated {
    readonly result?: { readonly type?: string; readonly value?: unknown; readonly unserializableValue?: string; readonly description?: string };
    readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string } };
}

// Runs `expression` in the page, awaiting a promise it returns, for at most `timeoutMs`: a synchronous loop is stopped
// by the browser at that deadline (Runtime.evaluate's `timeout`), a promise that never settles by the call's own.
const evaluateRaw = async (session: CdpSession, expression: string, timeoutMs: number): Promise<Evaluated> => {
    let answer: Evaluated;
    try {
        answer = await session.send<Evaluated>(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs },
            timeoutMs + ANSWER_MARGIN_MS,
        );
    } catch (error) {
        if (error instanceof BrowserTimeoutError) {
            throw new BrowserError(
                `The script did not finish within ${Math.round(timeoutMs / 1000)} s.`,
                "A promise it returned never settled, or the page is stuck: give it a longer timeoutMs, or check the page with browser_console.",
            );
        }
        throw error;
    }
    if (answer.exceptionDetails !== undefined) {
        const why = answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "script error";
        throw new BrowserError(`The page threw: ${why}`);
    }
    return answer;
};

// A value as JSON text: `undefined`, NaN, Infinity and a BigInt as the console writes them, a DOM node or function by what
// the browser calls it (they do not serialise), anything long cut and said so.
export const valueText = (result: Evaluated["result"]): string => {
    if (result === undefined || result.type === "undefined") {
        return "undefined";
    }
    if (result.unserializableValue !== undefined) {
        return result.unserializableValue;
    }
    const text = "value" in result ? (JSON.stringify(result.value, null, 2) ?? String(result.value)) : (result.description ?? String(result.type));
    return text.length <= MAX_VALUE_TEXT ? text : `${text.slice(0, MAX_VALUE_TEXT)}\n… (cut here: ${text.length - MAX_VALUE_TEXT} more characters)`;
};

export const evaluateWithin = async (session: CdpSession, expression: string, timeoutMs: number): Promise<string> =>
    valueText((await evaluateRaw(session, expression, timeoutMs)).result);

// The page's half of `frames`, run for as long as its own waits can take, plus the adapter query after them.
export const measureFrames = async (session: CdpSession, script: string, options: FramesOptions): Promise<RawFrames> => {
    // SAFETY: framesScript answers exactly this object.
    const value = (await evaluateRaw(session, script, options.waitMs + options.measureMs + 2 * STALL_MS + 15_000)).result?.value as RawFrames | undefined;
    if (value === undefined) {
        throw new BrowserError("The page answered nothing to the frame measurement.");
    }
    return value;
};

// A PNG's own size, from its header: what the image really is, whatever was asked for.
export const pngSize = (png: Buffer): { readonly width: number; readonly height: number } =>
    png.length >= 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : { width: 0, height: 0 };

// The rectangle to capture, in CSS pixels of the document: the visible viewport, or one element's part of it.
interface Area {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
    readonly what: string;
}

const areaScript = (selector: string | undefined): string => `(function () {
  var dpr = window.devicePixelRatio || 1, v = window.visualViewport;
  var view = v ? { x: v.pageLeft, y: v.pageTop, width: v.width, height: v.height } : { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight };
  ${
      selector === undefined
          ? "return { x: view.x, y: view.y, width: view.width, height: view.height, dpr: dpr, what: 'the visible page' };"
          : `var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('No element on this page matches ' + ${JSON.stringify(JSON.stringify(selector))} + '.');
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  var r = el.getBoundingClientRect();
  view = v ? { x: v.pageLeft, y: v.pageTop, width: v.width, height: v.height } : { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight };
  var left = Math.max(r.left + scrollX, view.x), top = Math.max(r.top + scrollY, view.y);
  var right = Math.min(r.right + scrollX, view.x + view.width), bottom = Math.min(r.bottom + scrollY, view.y + view.height);
  var name = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
  if (right <= left || bottom <= top) throw new Error(name + ' has no visible area: it is hidden, empty or outside the window.');
  return { x: left, y: top, width: right - left, height: bottom - top, dpr: dpr, what: name };`
  }
})()`;

// Captures from the compositor's surface, which is what makes a WebGL or WebGPU canvas come out as it is drawn rather than
// blank. The tab is brought to the front first: a background tab is not composited, so it would answer stale or not at
// all. The image is shrunk to what a model reads whole (MODEL_IMAGE_LIMITS) by the browser itself, through the clip's scale.
export const captureScreenshot = async (session: CdpSession, selector: string | undefined, limits: ImageLimits = MODEL_IMAGE_LIMITS): Promise<PageShot> => {
    // allow(silent-catch): bringing the tab forward helps the capture; a browser that refuses still captures what it can
    await session.send("Page.bringToFront").catch(() => undefined);
    const raw = (await evaluateRaw(session, areaScript(selector), 10_000)).result?.value;
    // SAFETY: areaScript answers exactly this object, or throws.
    const area = raw as Area;
    const deviceWidth = area.width * area.dpr;
    const deviceHeight = area.height * area.dpr;
    const fitted = fitSize(Math.max(1, Math.round(deviceWidth)), Math.max(1, Math.round(deviceHeight)), limits);
    const scale = Math.min(1, fitted.width / Math.max(1, deviceWidth));
    const shot = await session.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: area.x, y: area.y, width: area.width, height: area.height, scale },
    });
    const png = Buffer.from(shot.data, "base64");
    return { png, ...pngSize(png), what: area.what, cssWidth: Math.round(area.width), cssHeight: Math.round(area.height), devicePixelRatio: area.dpr };
};
