import type { CapturedNetworkRequest, PostHogConfig } from "posthog-js";
import { maskText } from "./replayText";

// What a session replay may keep of the screen: layout, clicks, scrolling, the interface's own wording, numbers, and what
// a machine reported about a failed setup, and nothing else that a person, an agent or the workspace put there. Every
// rule is default-deny, so a view added later is masked before anyone has heard of it.
//
// Text: `maskTextSelector: "*"` sends every text node through `maskText` (replayText.ts, which has the rules) with the
// element it sits in. What no rule recognises turns into asterisks.
//
// Attributes: words in attributes (`title`, `aria-label`, `placeholder`) pass the same test. Addresses and paths are
// always masked. Identifiers and `data-*` values survive only as a bare lowercase word or a number, which is what the
// styling hooks are (`data-icon="folder"`), so icons and colours still replay.
//
// Regions: what a mask cannot empty is blocked, so the recording holds a box of the same size. That covers the code
// editor and its diff (Monaco), terminals (xterm) and every element that draws pixels or another page.
//
// The recorder follows the PostHog project's own settings for canvas frames, console output, request and response
// bodies and headers, network timing (a request URL carries a file path) and web vitals attribution (a CSS selector and a
// resource URL). Nothing here pins those settings, so each is switched off by name.
//
// The privacy policy says what a replay holds (_site/site-content/src/legal.ts). Change one, change the other.

// Elements blocked whole. `.monaco-editor` covers the editor and both sides of its diff, `.xterm` a terminal in either
// renderer. The rest draw pixels or another document, which no text mask reaches.
const BLOCKED = [`.monaco-editor`, `.monaco-diff-editor`, `.xterm`, `canvas`, `img`, `picture`, `image`, `video`, `audio`, `iframe`, `object`, `embed`];

// A conversation's turns, blocked whole on a touch screen: its every text node is masked to asterisks anyway, and
// serialising and masking a transcript's DOM as it mounts and streams cost a phone about a third more main thread to
// open a chat (measured at 4× CPU throttle). The replay keeps a box of the same size where the turns were.
const TOUCH_BLOCKED = [`.chat-turns`];

// Attributes whose value is words a reader sees (or a screen reader speaks): allowed only if we wrote them.
const WORDS = new Set([
    `alt`,
    `aria-description`,
    `aria-label`,
    `aria-placeholder`,
    `aria-roledescription`,
    `aria-valuetext`,
    `data-placeholder`,
    `data-tip`,
    `data-tooltip`,
    `label`,
    `placeholder`,
    `title`,
]);

// Attributes whose value is an address, or a path a view hangs on an element. `data-drop-dir`, `data-home-tile` and
// `data-chat-tab` are often one lowercase word (a top-level folder, a conversation id) and would pass the keyword rule
// below, so they are named. The gap is a new `data-*` that carries a path and happens to be one lowercase word.
const LOCATORS = new Set([
    `action`,
    `cite`,
    `data`,
    `data-chat-tab`,
    `data-drop-dir`,
    `data-file`,
    `data-home-tile`,
    `data-path`,
    `data-uri`,
    `download`,
    `formaction`,
    `href`,
    `poster`,
    `src`,
    `srcset`,
    `xlink:href`,
]);

// Attributes that name or point at another element or a choice. Kept only while they read as a keyword.
const TOKENS = new Set([`aria-activedescendant`, `aria-controls`, `aria-describedby`, `aria-labelledby`, `aria-owns`, `for`, `id`, `list`, `name`, `value`]);

// One to four lowercase words joined by a hyphen or a space, or a short number: `folder`, `warn`, `small text`, `3`.
// A path, a file name, an id with digits or an underscore, and a sentence with capitals are none of these.
const KEYWORD = /^(?:[a-z][a-z-]{0,23}(?: [a-z][a-z-]{0,23}){0,3}|\d{1,6})$/;

const stars = (text: string): string => text.replace(/\S/g, `*`);

export const maskAttribute = (name: string, value: string, element?: Element): string => {
    const key = name.toLowerCase();
    if (WORDS.has(key)) {
        return maskText(value);
    }
    if (LOCATORS.has(key)) {
        // A fragment names an element of this document (`<use href="#glyph">`), and a `<link>` is the app's own.
        return value.startsWith(`#`) || element?.localName === `link` ? value : stars(value);
    }
    if (TOKENS.has(key) || (key.startsWith(`data-`) && !key.startsWith(`data-v-`))) {
        return KEYWORD.test(value) ? value : stars(value);
    }
    // A thumbnail set as a background carries its address in the style.
    return key === `style` ? value.replace(/url\([^)]*\)/gi, `url()`) : value;
};

/**
 * What `posthog.init` gets so that a replay never holds the workspace, see the head of this file. `redactAddress` is
 * `addressRedactor` from eventPrivacy.ts, which the recorder runs the address of the page it records through.
 */
export const replayPrivacy = (redactAddress: (address: string) => string, screen: { readonly touch?: boolean } = {}) =>
    ({
        session_recording: {
            maskAllInputs: true,
            maskTextSelector: `*`,
            maskTextFn: (text: string, element?: HTMLElement | null) => maskText(text, element),
            maskAttributeFn: maskAttribute,
            blockSelector: [...BLOCKED, ...(screen.touch === true ? TOUCH_BLOCKED : [])].join(`,`),
            captureCanvas: { recordCanvas: false },
            recordBody: false,
            recordHeaders: false,
            // The page load's own performance entry is dropped, since its URL is the full address. A `name` alone is the page
            // being recorded, and any request the recorder keeps would come through here too.
            maskCapturedNetworkRequestFn: (request: CapturedNetworkRequest): CapturedNetworkRequest | undefined =>
                request.isInitial === true ? undefined : { ...request, name: redactAddress(request.name) },
        },
        enable_recording_console_log: false,
        // Attribution is what puts a CSS selector of the element and a resource URL on a web vitals event.
        capture_performance: { network_timing: false, web_vitals_attribution: false },
    }) satisfies Partial<PostHogConfig>;
