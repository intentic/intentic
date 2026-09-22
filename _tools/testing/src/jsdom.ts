import { createRequire } from "node:module";

// jsdom ships no types and the repo carries none: the one constructor and window the DOM setup reaches.
export type JsdomOptions = {
    url?: string;
    pretendToBeVisual?: boolean;
    runScripts?: "dangerously" | "outside-only";
    contentType?: string;
};

export type Jsdom = { readonly window: Window & typeof globalThis };

type JsdomConstructor = new (html?: string, options?: JsdomOptions) => Jsdom;

// Reached through require: an ESM import of an untyped package is an implicit `any` the checker refuses.
export const JSDOM: JsdomConstructor = (createRequire(import.meta.url)("jsdom") as { JSDOM: JsdomConstructor }).JSDOM;
