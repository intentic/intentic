// THE HERO'S LIVE FRAME: the demo (_site/demo), running in an iframe inside the hero's window, answering clicks in place
// rather than sending the visitor to /demo/. The frame stands on a poster, a screenshot of the very view it opens on,
// and the swap happens only once the app says it has drawn.
//
// - Wide screens load it by themselves, once the page has loaded, the browser is idle and the frame is on screen. It is
//   drawn at the poster's own 1280×720 and scaled to the frame, never below MIN_SCALE: past that the frame draws a
//   narrower app instead of smaller type.
// - Phones, and readers who asked for less data, keep the poster until they press it: then the frame loads over the
//   whole window, where a phone-sized app has the room it needs. A phone-sized frame inside the page would be a scroll trap.
// - "Full screen" lifts the same element into the top layer (it is a popover) and puts it back, so the app keeps its
//   state both ways. Moving an iframe in the document reloads it.
// - The frame's storage is sealed and its focus held until it is pressed; that half is the demo's (_site/demo/src/embed.ts).

/** The frame's name, which is how the demo knows it is the hero and which look to wear (EMBED_NAME in _site/demo/src/embed.ts). */
const EMBED_NAME = `intentic-demo-hero`;
/** On the site's light skin the app is drawn unskinned in daylight, as the light poster was. */
const LIGHT_SUFFIX = `:light`;
/** What the frame posts once its first view has drawn (READY_MESSAGE in _site/demo/src/embed.ts). */
const READY_MESSAGE = `intentic-demo:ready`;

/** The viewport the poster was captured at (capture.mts `hero-home`), so the live frame lines up with it. */
const LOGICAL_WIDTH = 1280;
const ASPECT = 9 / 16;
/** Below this the app's 13px type stops reading; a narrower frame draws a narrower app instead. */
const MIN_SCALE = 0.75;
/** How long a frame may take to draw before the hero gives up on it and leaves the poster. */
const READY_TIMEOUT_MS = 30_000;

type LiveState = `poster` | `loading` | `live` | `failed`;

interface LiveParts {
    readonly root: HTMLElement;
    readonly stage: HTMLElement;
    readonly start: HTMLElement;
    readonly expand: HTMLButtonElement;
    readonly close: HTMLButtonElement;
    readonly posters: readonly HTMLElement[];
    readonly src: string;
}

const whenIdle = (then: () => void): void => {
    if (`requestIdleCallback` in window) {
        window.requestIdleCallback(then, { timeout: 2_000 });
    } else {
        setTimeout(then, 200);
    }
};

const afterLoad = (then: () => void): void => {
    if (document.readyState === `complete`) {
        then();
    } else {
        window.addEventListener(`load`, then, { once: true });
    }
};

const findParts = (): LiveParts | undefined => {
    const root = document.querySelector<HTMLElement>(`[data-live]`);
    const stage = root?.querySelector<HTMLElement>(`[data-live-stage]`);
    const start = root?.querySelector<HTMLElement>(`[data-live-start]`);
    const expand = root?.querySelector<HTMLButtonElement>(`[data-live-expand]`);
    const close = root?.querySelector<HTMLButtonElement>(`[data-live-close]`);
    const src = root?.dataset[`src`];
    if (!root || !stage || !start || !expand || !close || !src) {
        return undefined;
    }
    return { root, stage, start, expand, close, src, posters: [...root.querySelectorAll<HTMLElement>(`[data-live-poster]`)] };
};

class LiveHero {
    readonly #parts: LiveParts;
    readonly #wide = window.matchMedia(`(min-width: 48rem)`);
    readonly #popover = `showPopover` in HTMLElement.prototype;
    #state: LiveState = `poster`;
    #frame: HTMLIFrameElement | undefined;
    #timeout: ReturnType<typeof setTimeout> | undefined;
    #expanded = false;
    #returnFocus: HTMLElement | undefined;

    constructor(parts: LiveParts) {
        this.#parts = parts;
    }

    mount(): void {
        const { start, expand, close, stage } = this.#parts;
        start.addEventListener(`click`, () => this.#press());
        expand.addEventListener(`click`, () => this.#open());
        close.addEventListener(`click`, () => this.#shut());
        document.addEventListener(`keydown`, (event) => {
            if (event.key === `Escape` && this.#expanded) {
                this.#shut();
            }
        });
        window.addEventListener(`message`, (event) => this.#hear(event));
        this.#wide.addEventListener(`change`, () => this.#sync());
        new ResizeObserver(() => this.#fit()).observe(stage);
        this.#sync();
        if (this.#wide.matches && !window.matchMedia(`(prefers-reduced-data: reduce)`).matches) {
            afterLoad(() => whenIdle(() => this.#loadWhenSeen()));
        }
    }

    // Which of the two the reader is given: the frame once it is live and drawn in the page, the poster otherwise. A
    // narrow screen never draws the frame in the page (focused-hero.css), so there the poster stays theirs.
    #sync(): void {
        const { root, start, expand, posters } = this.#parts;
        const live = this.#state === `live`;
        root.dataset[`state`] = this.#state;
        for (const poster of posters) {
            if (live && (this.#wide.matches || this.#expanded)) {
                poster.setAttribute(`aria-hidden`, `true`);
            } else {
                poster.removeAttribute(`aria-hidden`);
            }
        }
        // Out of the Tab order and the accessibility tree until it is shown. Not `visibility: hidden`, which may stop
        // the frame's animation frames, and the app's "drawn" mark waits on one.
        if (this.#frame !== undefined) {
            this.#frame.inert = !live;
        }
        start.hidden = live && this.#wide.matches;
        expand.hidden = !(live && this.#wide.matches && !this.#expanded);
    }

    #setState(next: LiveState): void {
        this.#state = next;
        this.#sync();
    }

    #loadWhenSeen(): void {
        const seen = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    seen.disconnect();
                    this.#load();
                }
            },
            { rootMargin: `200px 0px` },
        );
        seen.observe(this.#parts.root);
    }

    #load(): void {
        if (this.#frame !== undefined) {
            return;
        }
        const { stage, src } = this.#parts;
        const frame = document.createElement(`iframe`);
        // The light skin's `data-variant` value comes from the markup (lib/variant.ts DESK_VARIANT), not a copy here.
        const light = document.documentElement.dataset[`variant`] === this.#parts.root.dataset[`lightVariant`];
        frame.name = light ? `${EMBED_NAME}${LIGHT_SUFFIX}` : EMBED_NAME;
        frame.title = stage.getAttribute(`aria-label`) ?? ``;
        frame.src = src;
        stage.append(frame);
        this.#frame = frame;
        this.#setState(`loading`);
        this.#timeout = setTimeout(() => {
            if (this.#state === `loading`) {
                this.#setState(`failed`);
            }
        }, READY_TIMEOUT_MS);
    }

    #hear(event: MessageEvent): void {
        const fromFrame = this.#frame !== undefined && event.source === this.#frame.contentWindow && event.origin === window.location.origin;
        if (fromFrame && event.data === READY_MESSAGE) {
            clearTimeout(this.#timeout);
            this.#setState(`live`);
        }
    }

    // The frame is drawn at a desktop's size and scaled down to the window it sits in.
    #fit(): void {
        const { stage } = this.#parts;
        const width = stage.clientWidth;
        if (this.#expanded || width === 0) {
            return;
        }
        const scale = Math.min(1, Math.max(MIN_SCALE, width / LOGICAL_WIDTH));
        const logical = width / scale;
        stage.style.setProperty(`--live-w`, `${logical}px`);
        stage.style.setProperty(`--live-h`, `${logical * ASPECT}px`);
        stage.style.setProperty(`--live-scale`, String(scale));
    }

    // A failed frame still has somewhere to go: the demo in its own page.
    #press(): void {
        if (this.#state === `failed`) {
            window.location.assign(this.#parts.src);
        } else if (this.#wide.matches) {
            this.#load();
        } else {
            this.#open();
        }
    }

    #open(): void {
        this.#load();
        if (this.#expanded) {
            return;
        }
        const { root, stage, close } = this.#parts;
        this.#expanded = true;
        this.#returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        if (this.#popover) {
            stage.showPopover();
        }
        root.toggleAttribute(`data-expanded`, true);
        document.documentElement.classList.add(`live-open`);
        this.#sync();
        close.focus({ preventScroll: true });
    }

    #shut(): void {
        if (!this.#expanded) {
            return;
        }
        const { root, stage } = this.#parts;
        this.#expanded = false;
        if (this.#popover && stage.matches(`:popover-open`)) {
            stage.hidePopover();
        }
        root.toggleAttribute(`data-expanded`, false);
        document.documentElement.classList.remove(`live-open`);
        this.#fit();
        this.#sync();
        // Back where the reader left the page: focus alone would scroll the press into the middle of the window.
        this.#returnFocus?.focus({ preventScroll: true });
    }
}

export function mountLiveDemo(): void {
    const parts = findParts();
    // The site loaded inside its own hero (the demo's sign-out goes back to the demo, but any other way out lands here)
    // does not open a frame inside the frame.
    if (parts === undefined || window.top !== window.self) {
        return;
    }
    parts.start.hidden = false;
    new LiveHero(parts).mount();
}
