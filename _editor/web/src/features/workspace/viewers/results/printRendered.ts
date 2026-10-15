import { z } from "zod";

// Prints what a reading surface shows (a document's pages, a picture, rendered markdown, a web page, a PDF) from a
// document of its own in a hidden frame, so the app around it never reaches the paper and nothing the file carries
// runs: the copy keeps no script, no handler, no frame, and its frame is sandboxed without scripts, under a policy
// that loads nothing from outside this app. A PDF goes to the browser's own PDF printing instead.

// Out of sight but laid out, so the browser has a page to print.
const HIDDEN = `position:fixed;width:1px;height:1px;left:-10000px;top:0;border:0`;
// How long a web page's frame has to answer with what it shows now; one whose scripts are off never answers, and its
// page is printed as it was handed to the frame.
const ANSWER_MS = 2_000;
// A frame the browser never reported done printing is taken away regardless.
const LEFT_MS = 60_000;
// Styles and pictures from this app or carried inline; nothing from the internet, and no script at all.
const PRINT_POLICY = `default-src 'none'; style-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:`;

// A page frame's answer, parsed where it arrives: the page's own scripts can post anything.
const PrintAnswerSchema = z.object({ intenticPrintHtml: z.string() });

// The page each preview frame was handed, sealed but before any shell that writes it in (sizedFirst), set by the frame's
// owner (HtmlPreview.vue): what prints when the frame cannot answer, rather than a shell with nothing in it once its
// script is stripped. Keyed by the element, so a frame that is gone takes its entry with it.
// allow(module-state): weakly held, one entry per mounted preview frame
const handedPages = new WeakMap<HTMLIFrameElement, string>();

export const recordPrintSource = (frame: HTMLIFrameElement, page: string): void => {
    handedPages.set(frame, page);
};

// How often a page frame is asked while it has not answered: a preview may replace its frame as it settles.
const ASK_EVERY_MS = 250;

// What the web page in `host` shows right now, scripts' work included (htmlDocument.ts answers `intenticPrint`), asked of
// whichever frame is there at the time; or the page that frame was handed where none answers in time (a page whose
// scripts are off never does).
const pageSnapshot = (host: HTMLElement): Promise<string> =>
    new Promise((resolve) => {
        const current = (): HTMLIFrameElement | null => host.querySelector<HTMLIFrameElement>(`iframe[srcdoc]`);
        const finish = (html: string): void => {
            clearTimeout(timer);
            clearInterval(asking);
            window.removeEventListener(`message`, receive);
            resolve(html);
        };
        const receive = (event: MessageEvent): void => {
            const answer = PrintAnswerSchema.safeParse(event.data);
            const frame = current();
            if (frame !== null && event.source === frame.contentWindow && answer.success) {
                finish(answer.data.intenticPrintHtml);
            }
        };
        const handed = (): string => {
            const frame = current();
            return frame === null ? `` : (handedPages.get(frame) ?? frame.srcdoc);
        };
        const ask = (): void => current()?.contentWindow?.postMessage({ intenticPrint: true }, `*`);
        const timer = setTimeout(() => finish(handed()), ANSWER_MS);
        const asking = setInterval(ask, ASK_EVERY_MS);
        window.addEventListener(`message`, receive);
        ask();
    });

// The source as a document fit for paper: everything that could act stripped, the policy first in its head, and pages
// laid one per sheet where the surface drew a document's pages.
export const printableDocument = (source: string): string => {
    const parsed = new DOMParser().parseFromString(source, `text/html`);
    for (const node of parsed.querySelectorAll(`script,noscript,button,[role="toolbar"],iframe,frame,object,embed,base,meta[http-equiv]`)) {
        node.remove();
    }
    for (const element of parsed.querySelectorAll(`*`)) {
        // Names first: removing from the live attribute list while walking it would skip the one after each removal.
        for (const name of element.getAttributeNames()) {
            const lower = name.toLowerCase();
            if (lower.startsWith(`on`) || ((lower === `href` || lower === `src` || lower === `action`) && /^\s*javascript:/i.test(element.getAttribute(name) ?? ``))) {
                element.removeAttribute(name);
            }
        }
    }
    const policy = parsed.createElement(`meta`);
    policy.setAttribute(`http-equiv`, `Content-Security-Policy`);
    policy.setAttribute(`content`, PRINT_POLICY);
    const paper = parsed.querySelector(`.docx-wrapper, .odf-page`) !== null;
    const style = parsed.createElement(`style`);
    style.textContent = `html,body{height:auto!important;overflow:visible!important;background:white!important;color:black}
        *{max-height:none!important;overflow:visible!important}
        .docx-wrapper{padding:0!important;background:white!important;zoom:1!important}
        section.docx,.odf-page{transform:none!important;zoom:1!important;margin:0!important;box-shadow:none!important;break-after:page}
        section.docx:last-child,.odf-page:last-child{break-after:auto}
        img{max-width:100%} @page{margin:${paper ? `0` : `15mm`}}`;
    parsed.head.prepend(policy);
    parsed.head.append(style);
    return `<!doctype html>${parsed.documentElement.outerHTML}`;
};

const printDocument = async (source: string): Promise<void> => {
    const frame = document.createElement(`iframe`);
    // Same origin without scripts: this window can call print() on it, and nothing inside it can run.
    frame.setAttribute(`sandbox`, `allow-same-origin allow-modals`);
    frame.setAttribute(`aria-hidden`, `true`);
    frame.style.cssText = HIDDEN;
    frame.srcdoc = printableDocument(source);
    const loaded = new Promise<void>((resolve) => frame.addEventListener(`load`, () => resolve(), { once: true }));
    document.body.append(frame);
    await loaded;
    const inside = frame.contentDocument;
    await inside?.fonts.ready;
    // allow(silent-catch): a picture that cannot decode prints as the browser draws it; waiting on it was only for timing.
    await Promise.all([...(inside?.images ?? [])].map((image) => image.decode().catch(() => undefined)));
    const remove = (): void => frame.remove();
    frame.contentWindow?.addEventListener(`afterprint`, remove, { once: true });
    setTimeout(remove, LEFT_MS);
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
};

// The PDF's own bytes, retyped so the frame can only ever draw them as a PDF, in the browser's PDF viewer.
const printPdf = async (source: string): Promise<void> => {
    const bytes = await (await fetch(source)).blob();
    const url = URL.createObjectURL(new Blob([bytes], { type: `application/pdf` }));
    const frame = document.createElement(`iframe`);
    frame.setAttribute(`aria-hidden`, `true`);
    frame.style.cssText = HIDDEN;
    const remove = (): void => {
        frame.remove();
        URL.revokeObjectURL(url);
    };
    frame.addEventListener(
        `load`,
        () => {
            frame.contentWindow?.focus();
            frame.contentWindow?.print();
        },
        { once: true },
    );
    frame.src = url;
    document.body.append(frame);
    setTimeout(remove, LEFT_MS);
};

// Prints the surface mounted in `host`, whichever it is.
export const printRendered = async (host: HTMLElement): Promise<void> => {
    if (host.querySelector(`iframe[srcdoc]`) !== null) {
        await printDocument(await pageSnapshot(host));
        return;
    }
    const pdf = host.querySelector<HTMLObjectElement>(`object[type="application/pdf"]`);
    if (pdf !== null) {
        await printPdf(pdf.data);
        return;
    }
    const styles = [...document.querySelectorAll(`style,link[rel="stylesheet"]`)].map((node) => node.outerHTML).join(``);
    await printDocument(`<html><head>${styles}</head><body>${host.innerHTML}</body></html>`);
};
