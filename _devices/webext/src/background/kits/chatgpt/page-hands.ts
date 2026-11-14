// the rule is exactly wrong for this file: every helper
// is nested inside the installer that defines it, since executeScript serializes and re-parses one function at a time
// inside the page, where nothing else in this module exists (the same rule as page/driver.ts).
import type { ChatGptPage, Lookup, Pattern } from "./site.js";

// The kit's helpers inside ChatGPT's tab, installed before every step by four small injected functions, and kept on the
// isolated world's window, where the page's own scripts never see them (as driver.ts keeps its refs). A document that
// is replaced loses them, and the next step installs them again. Four installers rather than one function because each
// injected function must carry its helpers whole, and one carrying all of them is past what this repository lets a
// function grow to.

// Counts taken before the prompt is sent, against which "a new answer" and "a new image" are judged. Kept by the worker,
// so they outlive a page that reloads mid-call.
export interface Baseline {
    readonly images: number;
    readonly user: number;
    readonly assistant: number;
    readonly turns: number;
}

export interface FoundImage {
    readonly src: string;
    readonly width: number;
    readonly height: number;
}

export interface PageState {
    readonly kind: "state";
    readonly signedOut: boolean;
    readonly composer: boolean;
    readonly personalization: "personalized" | "unpersonalized" | "absent";
    readonly generating: boolean;
    readonly counts: Baseline;
}

// Finding things the way the snapshot names them.
export interface Reading {
    readonly site: ChatGptPage;
    readonly regex: (from: Pattern) => RegExp;
    readonly squash: (text: string) => string;
    readonly textOf: (el: Element) => string;
    readonly nameOf: (el: Element) => string;
    readonly findAll: (lookup: Lookup) => Element[];
    readonly locate: (lookup: Lookup) => Element | undefined;
}

// Acting on them, and waiting.
export interface Acting {
    readonly press: (el: Element) => void;
    readonly key: (target: Element, name: string) => void;
    readonly until: <T>(look: () => T | undefined | false, waitMs: number) => Promise<T | undefined>;
    readonly composer: () => HTMLElement | undefined;
    readonly composerText: (el: HTMLElement) => string;
    readonly generating: () => boolean;
    readonly counts: () => Baseline;
    readonly personalization: () => PageState["personalization"];
    readonly state: () => PageState;
}

// Reading an answer against the baseline.
export interface Watching {
    readonly imagesSince: (baseline: Baseline) => FoundImage[];
    readonly textSince: (baseline: Baseline) => string;
    readonly answeredSince: (baseline: Baseline) => boolean;
    readonly alerts: () => string;
    readonly working: (baseline: Baseline) => string;
    readonly turnsSince: (baseline: Baseline) => Element[];
}

// What the answer waits on, and where the last answer began.
export interface Asking {
    // The names of the buttons ChatGPT is waiting on the person to press in the answer's own turns ("Confirm"), or "".
    readonly confirmations: (baseline: Baseline) => string;
    // The counts as they stood just before the conversation's last prompt, so the last answer is "since" them: what
    // chatgpt_read collects from a chat it did not send into in this call.
    readonly lastAnswerBaseline: () => Baseline;
}

declare global {
    interface Window {
        intenticChatgpt?: { reading?: Reading; acting?: Acting; watching?: Watching; asking?: Asking } | undefined;
    }
}

// Installs nothing, and takes away what an earlier document installed, unless the page is on `host`: a tab redirected
// mid-call (to auth.openai.com's sign-in, say) is a site outside the person's grant, and no step may read it.
export const installReading = (site: ChatGptPage, host: string): boolean => {
    if (location.host !== host) {
        window.intenticChatgpt = undefined;
        return false;
    }
    const regex = (from: Pattern): RegExp => new RegExp(from.source, from.flags);
    const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
    // innerText is what a person sees; jsdom and a detached node have only textContent.
    const textOf = (el: Element): string => (el instanceof HTMLElement ? el.innerText : undefined) ?? el.textContent ?? "";
    const editable = (el: Element): boolean => {
        const value = el.getAttribute("contenteditable");
        return (el instanceof HTMLElement && el.isContentEditable) || value === "" || value === "true" || value === "plaintext-only";
    };
    const implicitRole = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        if (tag === "button" || (tag === "input" && /^(submit|button)$/i.test(el.getAttribute("type") ?? ""))) {
            return "button";
        }
        if (tag === "a" && el.hasAttribute("href")) {
            return "link";
        }
        return tag === "textarea" || tag === "input" || editable(el) ? "textbox" : "";
    };
    const roleOf = (el: Element): string => {
        const explicit = el.getAttribute("role");
        return explicit !== null && explicit !== "" ? explicit : implicitRole(el);
    };
    // The accessible name as the snapshot computes it (page/driver.ts), so a name seen there finds the element here.
    const nameOf = (el: Element): string => {
        const labelled = (el.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .filter((id) => id !== "")
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
        const candidates = [el.getAttribute("aria-label"), labelled, el.getAttribute("alt"), el.getAttribute("placeholder"), el.getAttribute("title"), textOf(el)];
        return squash(candidates.find((candidate) => candidate !== null && candidate.trim() !== "") ?? "");
    };
    const visible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const fallbackOf = (lookup: Lookup): Element[] => {
        if (lookup.testId !== undefined) {
            return Array.from(document.querySelectorAll(`[data-testid="${lookup.testId}"]`));
        }
        const byId = lookup.id === undefined ? null : document.getElementById(lookup.id);
        return byId === null ? [] : [byId];
    };
    const findAll = (lookup: Lookup): Element[] => {
        const name = regex(lookup.name);
        const byRole = Array.from(document.querySelectorAll("*")).filter((el) => roleOf(el) === lookup.role && visible(el) && name.test(nameOf(el)));
        return byRole.length > 0 ? byRole : fallbackOf(lookup).filter(visible);
    };
    const locate = (lookup: Lookup): Element | undefined => findAll(lookup)[0];
    window.intenticChatgpt = { ...window.intenticChatgpt, reading: { site, regex, squash, textOf, nameOf, findAll, locate } };
    return true;
};

export const installActing = (): boolean => {
    const reading = window.intenticChatgpt?.reading;
    if (reading === undefined) {
        return false;
    }
    const { site, locate, findAll, regex, nameOf, textOf } = reading;
    // A person's click, in the order a pointer delivers it: menus built on Radix (ChatGPT's) open on pointerdown and
    // never on a bare click().
    const press = (el: Element): void => {
        el.scrollIntoView?.({ block: "center" });
        const rect = el.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        const Pointer = window.PointerEvent ?? window.MouseEvent;
        el.dispatchEvent(new Pointer("pointerdown", { ...init, pointerType: "mouse" }));
        el.dispatchEvent(new MouseEvent("mousedown", init));
        el.dispatchEvent(new Pointer("pointerup", { ...init, pointerType: "mouse" }));
        el.dispatchEvent(new MouseEvent("mouseup", init));
        el.dispatchEvent(new MouseEvent("click", init));
    };
    const key = (target: Element, name: string): void => {
        const code = { Enter: 13, Escape: 27 }[name] ?? 0;
        const init = { key: name, code: name, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
    };
    // Resolves with `look()`'s first answer that is neither undefined nor false, checked on every change to the page,
    // or with undefined at the cap. One timer, never a chain: the page may be hidden and throttled (agent-window.ts).
    const until = async <T>(look: () => T | undefined | false, waitMs: number): Promise<T | undefined> =>
        await new Promise((resolve) => {
            const seen = (): T | undefined => {
                const value = look();
                return value === false ? undefined : value;
            };
            const first = seen();
            if (first !== undefined) {
                resolve(first);
                return;
            }
            const finish = (value: T | undefined): void => {
                observer.disconnect();
                clearTimeout(cap);
                resolve(value);
            };
            const observer = new MutationObserver(() => {
                const value = seen();
                if (value !== undefined) {
                    finish(value);
                }
            });
            observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
            const cap = setTimeout(() => finish(seen()), waitMs);
        });
    const composer = (): HTMLElement | undefined => {
        const found = locate(site.composer);
        return found instanceof HTMLElement ? found : undefined;
    };
    const composerText = (el: HTMLElement): string => (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : textOf(el));
    const generating = (): boolean => locate(site.stop) !== undefined;
    const counts = (): Baseline => ({
        images: findAll(site.generatedImage).length,
        user: document.querySelectorAll(site.userTurn).length,
        assistant: document.querySelectorAll(site.assistantTurn).length,
        turns: document.querySelectorAll(site.anyTurn).length,
    });
    const personalization = (): PageState["personalization"] => {
        const button = locate(site.personalization);
        if (button === undefined) {
            return "absent";
        }
        return regex(site.unpersonalizedLabel).test(nameOf(button)) ? "unpersonalized" : "personalized";
    };
    const state = (): PageState => ({
        kind: "state",
        signedOut: locate(site.signIn) !== undefined,
        composer: composer() !== undefined,
        personalization: personalization(),
        generating: generating(),
        counts: counts(),
    });
    window.intenticChatgpt = {
        ...window.intenticChatgpt,
        acting: { press, key, until, composer, composerText, generating, counts, personalization, state },
    };
    return true;
};

export const installWatching = (): boolean => {
    const reading = window.intenticChatgpt?.reading;
    if (reading === undefined) {
        return false;
    }
    const { site, findAll, regex, squash, textOf } = reading;
    // The picture under one "Generated image N" button: inside it, or beside it under a near ancestor. ChatGPT may layer
    // a blurred copy under the picture, so of several the one named a generated image, and the widest, is taken.
    const pictureOf = (button: Element): FoundImage | undefined => {
        let scope: Element | null = button;
        let pictures = Array.from(button.querySelectorAll("img"));
        for (let level = 0; pictures.length === 0 && level < 4 && scope !== null; level += 1) {
            scope = scope.parentElement;
            pictures = scope === null ? [] : Array.from(scope.querySelectorAll("img"));
        }
        const named = pictures.filter((img) => regex(site.generatedImageAlt).test(img.alt));
        const loaded = (named.length > 0 ? named : pictures).filter((img) => (img.currentSrc || img.src) !== "");
        const best = loaded.reduce<HTMLImageElement | undefined>((widest, img) => (widest === undefined || img.naturalWidth >= widest.naturalWidth ? img : widest), undefined);
        return best === undefined ? undefined : { src: best.currentSrc || best.src, width: best.naturalWidth || best.width, height: best.naturalHeight || best.height };
    };
    const imagesSince = (baseline: Baseline): FoundImage[] =>
        findAll(site.generatedImage)
            .slice(baseline.images)
            .flatMap((button) => pictureOf(button) ?? []);
    // The turns after the baseline's: by author where ChatGPT marks one, else every turn after the prompt's own.
    const turnsSince = (baseline: Baseline): Element[] => {
        const assistant = Array.from(document.querySelectorAll(site.assistantTurn));
        return assistant.length > 0 || baseline.assistant > 0
            ? assistant.slice(baseline.assistant)
            : Array.from(document.querySelectorAll(site.anyTurn)).slice(baseline.turns + 1);
    };
    const textSince = (baseline: Baseline): string =>
        turnsSince(baseline)
            .map((turn) => textOf(turn).trim())
            .filter((text) => text !== "")
            .join("\n\n")
            .slice(0, 400_000);
    const answeredSince = (baseline: Baseline): boolean => turnsSince(baseline).length > 0;
    const alerts = (): string =>
        Array.from(document.querySelectorAll('[role="alert"]'))
            .map((el) => squash(textOf(el)))
            .filter((text) => text !== "")
            .join(" ");
    // A working line ("Thinking", "Creating image") in the answer's own turns: one elsewhere on the page (a label left
    // over from an earlier turn, the sidebar) says nothing about this answer.
    const working = (baseline: Baseline): string => {
        const busy = regex(site.working);
        for (const turn of turnsSince(baseline)) {
            const line = Array.from(turn.querySelectorAll("*")).find((el) => el.children.length === 0 && busy.test(squash(textOf(el))));
            if (line !== undefined) {
                return squash(textOf(line)).slice(0, 80);
            }
        }
        return "";
    };
    window.intenticChatgpt = { ...window.intenticChatgpt, watching: { imagesSince, textSince, answeredSince, alerts, working, turnsSince } };
    return true;
};

export const installAsking = (): boolean => {
    const reading = window.intenticChatgpt?.reading;
    const watching = window.intenticChatgpt?.watching;
    if (reading === undefined || watching === undefined) {
        return false;
    }
    const { site, findAll, regex, squash, textOf } = reading;
    const { turnsSince } = watching;
    const confirmations = (baseline: Baseline): string => {
        const asking = regex(site.confirmation.name);
        const names = turnsSince(baseline).flatMap((turn) =>
            Array.from(turn.querySelectorAll('button, [role="button"]'))
                .map((button) => squash(textOf(button)) || squash(button.getAttribute("aria-label") ?? ""))
                .filter((name) => asking.test(name)),
        );
        return [...new Set(names)].join(", ");
    };
    // What precedes `mark` in the document, counted the way acting.counts counts the whole page.
    const before = (mark: Element, found: Element[]): number =>
        found.filter((el) => (el.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).length;
    const lastAnswerBaseline = (): Baseline => {
        const users = Array.from(document.querySelectorAll(site.userTurn));
        const last = users.at(-1);
        const all = {
            images: findAll(site.generatedImage),
            assistant: Array.from(document.querySelectorAll(site.assistantTurn)),
            turns: Array.from(document.querySelectorAll(site.anyTurn)),
        };
        if (last === undefined) {
            return { images: 0, user: 0, assistant: 0, turns: 0 };
        }
        // The prompt's own <article> counts among the turns before the answer (turnsSince skips one past it).
        const own = last.closest(site.anyTurn);
        const turns = own === null ? before(last, all.turns) : before(own, all.turns);
        return { images: before(last, all.images), user: users.length - 1, assistant: before(last, all.assistant), turns };
    };
    window.intenticChatgpt = { ...window.intenticChatgpt, asking: { confirmations, lastAnswerBaseline } };
    return true;
};
