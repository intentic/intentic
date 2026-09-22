// jsdom ships no types and the repo carries none: the one constructor and window the DOM setup reaches.
declare module "jsdom" {
    export type JsdomOptions = {
        url?: string;
        pretendToBeVisual?: boolean;
        runScripts?: "dangerously" | "outside-only";
        contentType?: string;
    };
    export class JSDOM {
        constructor(html?: string, options?: JsdomOptions);
        readonly window: Window & typeof globalThis;
    }
}
