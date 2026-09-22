/// <reference path="./jsdom.d.ts" />
import { JSDOM } from "jsdom";

// A DOM for the suite that imports this first, or the package that preloads it first: a jsdom window's members become globals with the same override rule
// the jsdom environment applied, so a suite ported from it sees the same `document`, `Event` and `navigator`.
// Node keeps every global not named below (fetch, URL, setTimeout, console); jsdom's copy replaces Node's for the
// DOM interfaces and window members that are.

// jsdom's living-standard interfaces: replace Node's own where both exist (Event, EventTarget, Blob, File, ...).
const LIVING_KEYS = [
    `DOMException`,
    `EventTarget`,
    `NamedNodeMap`,
    `Node`,
    `Attr`,
    `Element`,
    `DocumentFragment`,
    `DOMImplementation`,
    `Document`,
    `XMLDocument`,
    `CharacterData`,
    `Text`,
    `CDATASection`,
    `ProcessingInstruction`,
    `Comment`,
    `DocumentType`,
    `NodeList`,
    `RadioNodeList`,
    `HTMLCollection`,
    `HTMLOptionsCollection`,
    `DOMStringMap`,
    `DOMTokenList`,
    `StyleSheetList`,
    `HTMLElement`,
    `HTMLHeadElement`,
    `HTMLTitleElement`,
    `HTMLBaseElement`,
    `HTMLLinkElement`,
    `HTMLMetaElement`,
    `HTMLStyleElement`,
    `HTMLBodyElement`,
    `HTMLHeadingElement`,
    `HTMLParagraphElement`,
    `HTMLHRElement`,
    `HTMLPreElement`,
    `HTMLUListElement`,
    `HTMLOListElement`,
    `HTMLLIElement`,
    `HTMLMenuElement`,
    `HTMLDListElement`,
    `HTMLDivElement`,
    `HTMLAnchorElement`,
    `HTMLAreaElement`,
    `HTMLBRElement`,
    `HTMLButtonElement`,
    `HTMLCanvasElement`,
    `HTMLDataElement`,
    `HTMLDataListElement`,
    `HTMLDetailsElement`,
    `HTMLDialogElement`,
    `HTMLDirectoryElement`,
    `HTMLFieldSetElement`,
    `HTMLFontElement`,
    `HTMLFormElement`,
    `HTMLHtmlElement`,
    `HTMLImageElement`,
    `HTMLInputElement`,
    `HTMLLabelElement`,
    `HTMLLegendElement`,
    `HTMLMapElement`,
    `HTMLMarqueeElement`,
    `HTMLMediaElement`,
    `HTMLMeterElement`,
    `HTMLModElement`,
    `HTMLOptGroupElement`,
    `HTMLOptionElement`,
    `HTMLOutputElement`,
    `HTMLPictureElement`,
    `HTMLProgressElement`,
    `HTMLQuoteElement`,
    `HTMLScriptElement`,
    `HTMLSelectElement`,
    `HTMLSlotElement`,
    `HTMLSourceElement`,
    `HTMLSpanElement`,
    `HTMLTableCaptionElement`,
    `HTMLTableCellElement`,
    `HTMLTableColElement`,
    `HTMLTableElement`,
    `HTMLTimeElement`,
    `HTMLTableRowElement`,
    `HTMLTableSectionElement`,
    `HTMLTemplateElement`,
    `HTMLTextAreaElement`,
    `HTMLUnknownElement`,
    `HTMLFrameElement`,
    `HTMLFrameSetElement`,
    `HTMLIFrameElement`,
    `HTMLEmbedElement`,
    `HTMLObjectElement`,
    `HTMLParamElement`,
    `HTMLVideoElement`,
    `HTMLAudioElement`,
    `HTMLTrackElement`,
    `HTMLFormControlsCollection`,
    `SVGElement`,
    `SVGGraphicsElement`,
    `SVGSVGElement`,
    `SVGTitleElement`,
    `SVGAnimatedString`,
    `SVGNumber`,
    `SVGStringList`,
    `Event`,
    `CloseEvent`,
    `CustomEvent`,
    `MessageEvent`,
    `ErrorEvent`,
    `HashChangeEvent`,
    `PopStateEvent`,
    `StorageEvent`,
    `ProgressEvent`,
    `PageTransitionEvent`,
    `SubmitEvent`,
    `UIEvent`,
    `FocusEvent`,
    `InputEvent`,
    `MouseEvent`,
    `KeyboardEvent`,
    `TouchEvent`,
    `CompositionEvent`,
    `WheelEvent`,
    `BarProp`,
    `External`,
    `Location`,
    `History`,
    `Screen`,
    `Crypto`,
    `Performance`,
    `Navigator`,
    `PluginArray`,
    `MimeTypeArray`,
    `Plugin`,
    `MimeType`,
    `FileReader`,
    `FormData`,
    `Blob`,
    `File`,
    `FileList`,
    `ValidityState`,
    `DOMParser`,
    `XMLSerializer`,
    `XMLHttpRequestEventTarget`,
    `XMLHttpRequestUpload`,
    `XMLHttpRequest`,
    `WebSocket`,
    `NodeFilter`,
    `NodeIterator`,
    `TreeWalker`,
    `AbstractRange`,
    `Range`,
    `StaticRange`,
    `Selection`,
    `Storage`,
    `CustomElementRegistry`,
    `ShadowRoot`,
    `MutationObserver`,
    `MutationRecord`,
    `Uint8Array`,
    `Uint16Array`,
    `Uint32Array`,
    `Uint8ClampedArray`,
    `Int8Array`,
    `Int16Array`,
    `Int32Array`,
    `Float32Array`,
    `Float64Array`,
    `ArrayBuffer`,
    `DOMRectReadOnly`,
    `DOMRect`,
    `Image`,
    `Audio`,
    `Option`,
    `CSS`,
];

// Window members that are not interfaces.
const OTHER_KEYS = [
    `addEventListener`,
    `alert`,
    `blur`,
    `cancelAnimationFrame`,
    `close`,
    `confirm`,
    `createPopup`,
    `dispatchEvent`,
    `document`,
    `focus`,
    `frames`,
    `getComputedStyle`,
    `history`,
    `innerHeight`,
    `innerWidth`,
    `length`,
    `location`,
    `matchMedia`,
    `moveBy`,
    `moveTo`,
    `name`,
    `navigator`,
    `open`,
    `outerHeight`,
    `outerWidth`,
    `pageXOffset`,
    `pageYOffset`,
    `parent`,
    `postMessage`,
    `print`,
    `prompt`,
    `removeEventListener`,
    `requestAnimationFrame`,
    `resizeBy`,
    `resizeTo`,
    `screen`,
    `screenLeft`,
    `screenTop`,
    `screenX`,
    `screenY`,
    `scroll`,
    `scrollBy`,
    `scrollLeft`,
    `scrollTo`,
    `scrollTop`,
    `scrollX`,
    `scrollY`,
    `self`,
    `stop`,
    `top`,
    `Window`,
    `window`,
];

// Aliases of the global itself, set by hand below rather than copied.
const SKIP_KEYS = new Set<string>([`window`, `self`, `top`, `parent`]);

const KEYS = new Set<string>([...LIVING_KEYS, ...OTHER_KEYS]);

type Global = Record<string, unknown>;

const isClassLikeName = (name: string): boolean => name[0] === name[0]?.toUpperCase();

// Every window key to register: all of jsdom's own, minus those Node already has unless the list above claims them.
const windowKeys = (global: Global, win: Global): Set<string> =>
    new Set([...KEYS, ...Object.getOwnPropertyNames(win)].filter((key) => !SKIP_KEYS.has(key) && (!(key in global) || KEYS.has(key))));

const populateGlobal = (global: Global, win: Global): void => {
    const overrides = new Map<string, unknown>();
    for (const key of windowKeys(global, win)) {
        const value = win[key];
        const bound = typeof value === `function` && !isClassLikeName(key) ? (value as (...args: unknown[]) => unknown).bind(win) : undefined;
        Object.defineProperty(global, key, {
            get: () => (overrides.has(key) ? overrides.get(key) : (bound ?? win[key])),
            set: (next: unknown) => {
                overrides.set(key, next);
            },
            configurable: true,
        });
    }
    global[`window`] = global;
    global[`self`] = global;
    global[`top`] = global;
    global[`parent`] = global;
    const document = global[`document`] as { defaultView?: unknown } | undefined;
    if (document?.defaultView !== undefined) {
        Object.defineProperty(document, `defaultView`, { get: () => global, enumerable: true, configurable: true });
    }
};

// A DOM error handler that throws fails the file, as it did before, unless the suite listens for `error` itself.
const catchWindowErrors = (win: Window): void => {
    let userErrorListeners = 0;
    win.addEventListener(`error`, (event) => {
        if (userErrorListeners === 0 && event.error != null) {
            event.preventDefault();
            queueMicrotask(() => {
                throw event.error;
            });
        }
    });
    const add = win.addEventListener.bind(win);
    const remove = win.removeEventListener.bind(win);
    win.addEventListener = ((...args: Parameters<Window[`addEventListener`]>) => {
        if (args[0] === `error`) {
            userErrorListeners += 1;
        }
        return add(...args);
    }) as Window[`addEventListener`];
    win.removeEventListener = ((...args: Parameters<Window[`removeEventListener`]>) => {
        if (args[0] === `error` && userErrorListeners > 0) {
            userErrorListeners -= 1;
        }
        return remove(...args);
    }) as Window[`removeEventListener`];
};

// jsdom's EventTarget wants its own AbortSignal; a Node signal handed to addEventListener is bridged to one.
const patchAddEventListener = (win: Global): void => {
    const controllers = new WeakMap<AbortSignal, AbortController>();
    const JsdomAbortSignal = win[`AbortSignal`] as typeof AbortSignal;
    const JsdomAbortController = win[`AbortController`] as typeof AbortController;
    const proto = (win[`EventTarget`] as typeof EventTarget).prototype;
    const original = proto.addEventListener;
    const bridged = (signal: AbortSignal): AbortSignal => {
        let controller = controllers.get(signal);
        if (controller === undefined) {
            controller = new JsdomAbortController();
            const forward = controller;
            signal.addEventListener(`abort`, () => forward.abort(signal.reason));
            controllers.set(signal, controller);
        }
        return controller.signal;
    };
    proto.addEventListener = function addEventListener(this: EventTarget, ...args: Parameters<EventTarget[`addEventListener`]>) {
        const [type, callback, options] = args;
        if (typeof options === `object` && options?.signal != null && !(options.signal instanceof JsdomAbortSignal)) {
            return original.call(this, type, callback, { ...options, signal: bridged(options.signal) });
        }
        return original.apply(this, args);
    };
};

const dom = new JSDOM(`<!DOCTYPE html>`, { pretendToBeVisual: true, url: `http://localhost:3000`, runScripts: `dangerously` });
const win = dom.window as unknown as Global;
const global = globalThis as unknown as Global;

// Before the runtime's signal classes replace jsdom's on the window: the bridge below keys on jsdom's own.
patchAddEventListener(win);

// Node's structured-data primitives, where jsdom has none of its own, and Node's fetch family always: a Response a
// component reads must be the one the runtime's fetch produced.
for (const name of [`structuredClone`, `TextEncoder`, `TextDecoder`]) {
    if (global[name] !== undefined && win[name] === undefined) {
        win[name] = global[name];
    }
}
for (const name of [`fetch`, `Response`, `Headers`, `AbortController`, `AbortSignal`, `URLSearchParams`]) {
    if (global[name] !== undefined) {
        win[name] = global[name];
    }
}

catchWindowErrors(dom.window as unknown as Window);
populateGlobal(global, win);

export { dom };
