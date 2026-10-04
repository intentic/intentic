import "@intentic/testing/dom";
import { registerCatalog } from "@intentic/ui/i18n";
import { maskAttribute, replayPrivacy } from "./replayPrivacy";

// The interface's own wording, as a real catalog registers it: what an attribute may keep. The text rules have their own
// suite (replayText.test.ts).
await registerCatalog({
    namespace: `probe`,
    base: { save: `Save` },
    load: () => Promise.reject(new Error(`unused`)),
});

const element = (tag: string): Element => document.createElement(tag);

// What a masked value must look like: not one character of it left, whatever it was.
const blank = (value: string): string => `*`.repeat(value.length);

describe(`attributes`, () => {
    it(`holds the words a screen reader or a tooltip speaks to the same rule as text`, () => {
        expect(maskAttribute(`title`, `Save`)).toBe(`Save`);
        expect(maskAttribute(`aria-label`, `Grace Hopper`)).toBe(`***** ******`);
        expect(maskAttribute(`placeholder`, `Grace's plans`)).toBe(`******* *****`);
        expect(maskAttribute(`ARIA-LABEL`, `Save`)).toBe(`Save`);
        expect(maskAttribute(`alt`, `screenshot of the invoice`)).toBe(`********** ** *** *******`);
    });

    it(`always masks an address or a path, except a fragment of this document and a stylesheet link`, () => {
        expect(maskAttribute(`href`, `/workspace/web/src/a.ts`)).toBe(blank(`/workspace/web/src/a.ts`));
        expect(maskAttribute(`src`, `blob:https://app.intentic.dev/1234`)).toBe(blank(`blob:https://app.intentic.dev/1234`));
        expect(maskAttribute(`data-drop-dir`, `api`)).toBe(`***`);
        expect(maskAttribute(`data-chat-tab`, `cnv`)).toBe(`***`);
        expect(maskAttribute(`href`, `#glyph`)).toBe(`#glyph`);
        expect(maskAttribute(`href`, `/assets/app.css`, element(`link`))).toBe(`/assets/app.css`);
        expect(maskAttribute(`href`, `/assets/app.css`, element(`a`))).toBe(blank(`/assets/app.css`));
    });

    // The styling hooks are single lowercase words and numbers; if these were masked, icons and colours would not replay.
    it(`keeps a data attribute or an id only while it reads as a keyword`, () => {
        expect(maskAttribute(`data-icon`, `folder`)).toBe(`folder`);
        expect(maskAttribute(`data-tone`, `warn`)).toBe(`warn`);
        expect(maskAttribute(`data-p`, `small text`)).toBe(`small text`);
        expect(maskAttribute(`data-mprt`, `3`)).toBe(`3`);
        expect(maskAttribute(`id`, `ws-viewer-context-main`)).toBe(`ws-viewer-context-main`);
        expect(maskAttribute(`aria-labelledby`, `row_4f9`)).toBe(blank(`row_4f9`));
        expect(maskAttribute(`data-file`, `readme`)).toBe(`******`);
        expect(maskAttribute(`data-row`, `src/a.ts`)).toBe(`********`);
        expect(maskAttribute(`data-row`, `Checkout`)).toBe(`********`);
        expect(maskAttribute(`value`, `/tmp/a b`)).toBe(`****** *`);
    });

    it(`leaves the rest of what a page needs to lay itself out alone`, () => {
        expect(maskAttribute(`class`, `flex gap-2`)).toBe(`flex gap-2`);
        expect(maskAttribute(`role`, `tablist`)).toBe(`tablist`);
        expect(maskAttribute(`d`, `M2 4h15v12H2Z`)).toBe(`M2 4h15v12H2Z`);
        expect(maskAttribute(`style`, `width: 4px`)).toBe(`width: 4px`);
    });

    it(`drops the address from a style that draws a picture`, () => {
        expect(maskAttribute(`style`, `background: url("blob:x/1") center; color: red`)).toBe(`background: url() center; color: red`);
    });
});

describe(`what posthog is told`, () => {
    const redact = (address: string): string => `redacted:${address}`;
    const options = replayPrivacy(redact);
    const { session_recording: recording } = options;

    it(`masks every text node and every typed value`, () => {
        expect(recording.maskTextSelector).toBe(`*`);
        expect(recording.maskAllInputs).toBe(true);
        expect(recording.maskTextFn(`src/checkout.ts`)).toBe(blank(`src/checkout.ts`));
        expect(recording.maskTextFn(`Save`)).toBe(`Save`);
        expect(recording.maskAttributeFn).toBe(maskAttribute);
    });

    // The recorder hands over the element a text node sits in, which is what lets a machine's report keep its words.
    it(`judges a text node by where it sits`, () => {
        const report = document.createElement(`p`);
        report.dataset[`replay`] = `diagnostic`;
        expect(recording.maskTextFn(`the network broke`, report)).toBe(`the network broke`);
        expect(recording.maskTextFn(`the network broke`, null)).toBe(`*** ******* *****`);
    });

    it(`blocks the editor, its diff, terminals and everything that draws pixels or another page`, () => {
        expect(recording.blockSelector.split(`,`)).toEqual([
            `.monaco-editor`,
            `.monaco-diff-editor`,
            `.xterm`,
            `canvas`,
            `img`,
            `picture`,
            `image`,
            `video`,
            `audio`,
            `iframe`,
            `object`,
            `embed`,
        ]);
    });

    // Each of these follows the PostHog project's own setting unless the client says no, and nothing here pins that.
    it(`switches off canvas frames, console output, request bodies and headers, network timing and web vitals attribution by name`, () => {
        expect(recording.captureCanvas).toEqual({ recordCanvas: false });
        expect(recording.recordBody).toBe(false);
        expect(recording.recordHeaders).toBe(false);
        expect(options.enable_recording_console_log).toBe(false);
        expect(options.capture_performance).toEqual({ network_timing: false, web_vitals_attribution: false });
    });

    it(`runs the address of the page it records through the redactor and drops the page load's own entry`, () => {
        const mask = recording.maskCapturedNetworkRequestFn;
        expect(mask({ name: `https://app.intentic.dev/workspace/src/a.ts#L3`, entryType: `navigation`, startTime: 0, duration: 0 })).toEqual({
            name: `redacted:https://app.intentic.dev/workspace/src/a.ts#L3`,
            entryType: `navigation`,
            startTime: 0,
            duration: 0,
        });
        expect(mask({ name: `https://app.intentic.dev/workspace/src/a.ts`, entryType: `navigation`, startTime: 0, duration: 0, isInitial: true })).toBeUndefined();
    });
});
