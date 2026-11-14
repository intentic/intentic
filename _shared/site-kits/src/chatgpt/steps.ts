// the rule is exactly wrong for this file: each step
// is handed to the page on its own, as source text (executeScript in the extension, Playwright's evaluate in the
// sandbox); what it shares with the others it reads from the helpers page-hands.ts installed on the window just before.
import type { Baseline, FoundImage, PageState } from "./page-hands.js";

// What runs inside ChatGPT's tab for the kit, one step per call. A step answers null when the helpers are missing (the
// document was replaced since they were installed), and the engine installs them and asks again. A step that waits
// does so on a MutationObserver plus single timers: the extension's agent window sits behind the person's, so its page
// gets no animation frames and its timers fire about once a second (its agent-window.ts).

export interface StepAnswer {
    readonly kind: "answer";
    readonly ok: boolean;
    readonly message: string;
}

export interface Watched {
    readonly kind: "watch";
    // done: ChatGPT has stopped with what was asked for: the new image(s) when judged as an image, its answer otherwise.
    // failed: it stopped and said why (`failure`). answered: judged as an image, it stopped with words and no image.
    // asking: it waits on the person to press one of its own buttons (`asks`). unsent: the prompt still sits in the
    // composer. working: none of these yet.
    readonly outcome: "done" | "failed" | "answered" | "asking" | "unsent" | "working";
    readonly images: FoundImage[];
    readonly text: string;
    readonly failure: string;
    readonly hint: string;
    readonly asks: string;
}

// What counts as done: a picture, or any finished answer.
export type Judged = "image" | "text";

// The page as it stands.
export const inspectStep = (): PageState | null => window.intenticChatgpt?.acting?.state() ?? null;

// Waits until the composer, or a sign-in button, is on the page.
export const readyStep = async (waitMs: number): Promise<PageState | null> => {
    const reading = window.intenticChatgpt?.reading;
    const acting = window.intenticChatgpt?.acting;
    if (reading === undefined || acting === undefined) {
        return null;
    }
    await acting.until(() => acting.composer() !== undefined || reading.locate(reading.site.signIn) !== undefined, waitMs);
    return acting.state();
};

// Sets the temporary chat's Personalized menu and reads back that it took: from the button's label, or, where the label
// does not change, by opening the menu again and reading which choice is checked.
export const personalizationStep = async (want: "personalized" | "unpersonalized", waitMs: number): Promise<StepAnswer | null> => {
    const reading = window.intenticChatgpt?.reading;
    const acting = window.intenticChatgpt?.acting;
    if (reading === undefined || acting === undefined) {
        return null;
    }
    const { site, locate, nameOf } = reading;
    const answer = (ok: boolean, message: string): StepAnswer => ({ kind: "answer", ok, message });
    const itemLookup = want === "unpersonalized" ? site.unpersonalizedItem : site.personalizedItem;
    const checked = (item: Element | undefined): boolean =>
        item !== undefined && (item.getAttribute("aria-checked") === "true" || item.getAttribute("data-state") === "checked");
    const closeMenu = (): void => {
        if (locate(itemLookup) !== undefined) {
            acting.key(document.activeElement ?? document.body, "Escape");
        }
    };
    const button = locate(site.personalization);
    if (button === undefined) {
        return answer(false, `ChatGPT's "Personalized" button is not on the page.`);
    }
    if (acting.personalization() === want) {
        return answer(true, `It already reads "${nameOf(button)}".`);
    }
    acting.press(button);
    const item = await acting.until(() => locate(itemLookup), waitMs);
    if (item === undefined) {
        return answer(false, `ChatGPT's personalization menu did not open, or has no "${want}" choice.`);
    }
    acting.press(item);
    // The menu closing is the page taking the choice; the label, where it changes, says which.
    await acting.until(() => acting.personalization() === want || checked(locate(itemLookup)) || locate(itemLookup) === undefined, waitMs);
    closeMenu();
    if (acting.personalization() === want) {
        return answer(true, `It now reads "${nameOf(locate(site.personalization) ?? button)}".`);
    }
    const again = locate(site.personalization);
    if (again === undefined) {
        return answer(false, `ChatGPT's "Personalized" button went away after the choice.`);
    }
    acting.press(again);
    const confirmed = checked(await acting.until(() => locate(itemLookup), waitMs));
    closeMenu();
    return confirmed ? answer(true, `Its menu shows "${want}" chosen.`) : answer(false, `ChatGPT's menu does not show "${want}" chosen.`);
};

// Replaces what the composer holds with the prompt, and reads it back. A rich editor (ProseMirror here; Lexical, Slate
// and Draft alike) keeps its own model of the text and rebuilds the DOM from it, so text written straight into the DOM
// is ignored or undone. These are the ways a person's own typing reaches such a model, tried until the editor reads
// back the prompt: the browser's own insertText, which raises the beforeinput and input events editors listen to; a
// paste, which every one of them handles; and a bare beforeinput, for one that listens to nothing else.
export const composeStep = async (prompt: string): Promise<StepAnswer | null> => {
    const reading = window.intenticChatgpt?.reading;
    const acting = window.intenticChatgpt?.acting;
    if (reading === undefined || acting === undefined) {
        return null;
    }
    const box = acting.composer();
    if (box === undefined) {
        return { kind: "answer", ok: false, message: `ChatGPT's message box is not on the page.` };
    }
    const wanted = reading.squash(prompt);
    const holds = (): boolean => reading.squash(acting.composerText(box)) === wanted;
    box.focus();
    if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")?.set?.call(box, prompt);
        box.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
        const selectAll = (): void => {
            const range = document.createRange();
            range.selectNodeContents(box);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
        };
        const attempts: (() => void)[] = [
            () => document.execCommand("insertText", false, prompt),
            () => {
                const data = new DataTransfer();
                data.setData("text/plain", prompt);
                box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
            },
            () => box.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: prompt, bubbles: true, cancelable: true })),
        ];
        for (const attempt of attempts) {
            selectAll();
            try {
                attempt();
            } catch {
                // allow(silent-catch): an API this browser lacks is the next attempt's turn, and the read-back judges
            }
            if (holds()) {
                break;
            }
        }
    }
    // An editor may apply the text a moment later; give it a change or two to the page.
    const held = holds() || (await acting.until(holds, 1500)) === true;
    return held
        ? { kind: "answer", ok: true, message: `The message box holds the prompt.` }
        : {
              kind: "answer",
              ok: false,
              message: `ChatGPT's message box did not take the prompt: it reads "${reading.squash(acting.composerText(box)).slice(0, 200)}".`,
          };
};

// Presses Send once it is enabled, or Enter in the composer when there is no Send button (or `via` says so). Answers
// at once, before ChatGPT moves the tab to the chat's own address, so the answer is not lost to that.
export const sendStep = async (via: "button" | "enter", waitMs: number): Promise<StepAnswer | null> => {
    const reading = window.intenticChatgpt?.reading;
    const acting = window.intenticChatgpt?.acting;
    if (reading === undefined || acting === undefined) {
        return null;
    }
    const enabled = (el: Element): boolean => !(el instanceof HTMLButtonElement && el.disabled) && el.getAttribute("aria-disabled") !== "true";
    if (via === "button") {
        const button = await acting.until(() => reading.findAll(reading.site.send).find(enabled), waitMs);
        if (button !== undefined) {
            acting.press(button);
            return { kind: "answer", ok: true, message: `Pressed Send.` };
        }
    }
    const box = acting.composer();
    if (box === undefined) {
        return { kind: "answer", ok: false, message: `There is no Send button and no message box to press Enter in.` };
    }
    box.focus();
    acting.key(box, "Enter");
    return { kind: "answer", ok: true, message: `Pressed Enter in the message box.` };
};

// Watches for one round of at most `roundMs`: answers as soon as ChatGPT is done, has failed, or has plainly not been
// sent, else "working" at the round's end. Words are judged only once the page has been still (no Stop button) for
// `settleMs`, since an answer pauses between its words and its picture. Its timers are single ones, each scheduled
// from the step or an observer callback, never a chain: Chrome throttles chained timers in a hidden page to one wake a
// minute.
export const watchStep = async (baseline: Baseline, prompt: string, roundMs: number, settleMs: number, judged: Judged = "image"): Promise<Watched | null> => {
    const reading = window.intenticChatgpt?.reading;
    const acting = window.intenticChatgpt?.acting;
    const watching = window.intenticChatgpt?.watching;
    const asking = window.intenticChatgpt?.asking;
    if (reading === undefined || acting === undefined || watching === undefined || asking === undefined) {
        return null;
    }
    const { site, regex, squash } = reading;
    const LOOK_GAP_MS = 250;
    const wanted = squash(prompt);
    const failing = (said: string): boolean => regex(site.limit).test(said) || regex(site.error).test(said);
    const watched = (outcome: Watched["outcome"], extra: Partial<Pick<Watched, "images" | "failure" | "asks">> = {}): Watched => {
        const said = { text: watching.textSince(baseline), hint: watching.working(baseline) };
        return { kind: "watch", outcome, images: extra.images ?? [], failure: extra.failure ?? "", asks: extra.asks ?? "", ...said };
    };
    const stillComposed = (): boolean => {
        const box = acting.composer();
        return box !== undefined && wanted !== "" && squash(acting.composerText(box)) === wanted;
    };
    const sent = (): boolean => {
        const now = acting.counts();
        return now.user > baseline.user || now.images > baseline.images || watching.answeredSince(baseline) || acting.generating() || !stillComposed();
    };
    // Before anything shows the prompt went: a limit that blocked it, or, once the page has been still, unsent.
    const unsent = (settled: boolean, blocked = watching.alerts()): Watched | undefined =>
        failing(blocked) ? watched("failed", { failure: blocked }) : settled ? watched("unsent") : undefined;
    // Once ChatGPT has stopped: the picture, a failure in its words or an alert, or words alone.
    const stopped = (): Watched | undefined => {
        // An answer still showing a working line ("Creating image") is not done, whatever the Stop button says: its
        // picture may be a partial one.
        if (watching.working(baseline) !== "") {
            return undefined;
        }
        const images = watching.imagesSince(baseline);
        if (images.length > 0) {
            return watched("done", { images });
        }
        const text = watching.textSince(baseline);
        const said = [text, watching.alerts()].find(failing);
        if (said !== undefined) {
            return watched("failed", { failure: said });
        }
        if (!watching.answeredSince(baseline)) {
            return undefined;
        }
        // A refusal is judged only of a picture that did not come: in a written answer "can't help" is just words.
        return judged === "text" ? watched("done") : regex(site.refusal).test(text) ? watched("failed", { failure: text }) : watched("answered");
    };
    // A verdict, or undefined to keep watching.
    const verdict = (settled: boolean): Watched | undefined => {
        if (!sent()) {
            return unsent(settled);
        }
        // A button of ChatGPT's own waiting on the person ends the watch, Stop or not: the kit never presses one.
        const asks = asking.confirmations(baseline);
        return asks !== "" ? watched("asking", { asks }) : acting.generating() || !settled ? undefined : stopped();
    };
    return await new Promise<Watched>((resolve) => {
        let stillSince: number | undefined;
        let recheck: ReturnType<typeof setTimeout> | undefined;
        const settled = (): boolean => stillSince !== undefined && Date.now() - stillSince >= settleMs;
        const finish = (result: Watched): void => {
            observer.disconnect();
            clearTimeout(pending);
            clearTimeout(recheck);
            clearTimeout(cap);
            resolve(result);
        };
        const look = (): void => {
            stillSince = acting.generating() ? undefined : (stillSince ?? Date.now());
            const result = verdict(settled());
            if (result !== undefined) {
                finish(result);
                return;
            }
            if (stillSince !== undefined && recheck === undefined) {
                const left = Math.max(settleMs - (Date.now() - stillSince), 0);
                recheck = setTimeout(() => {
                    recheck = undefined;
                    look();
                }, left + 50);
            }
        };
        // ChatGPT changes its page many times a second while it streams, and every look reads the whole page, so changes
        // are looked at no more than every LOOK_GAP_MS.
        let pending: ReturnType<typeof setTimeout> | undefined;
        const observer = new MutationObserver(() => {
            pending ??= setTimeout(() => {
                pending = undefined;
                look();
            }, LOOK_GAP_MS);
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        const cap = setTimeout(() => finish(verdict(settled()) ?? watched("working")), roundMs);
        look();
    });
};

// The counts just before the conversation's last prompt, for collecting its answer (chatgpt_read).
export const lastAnswerStep = (): Baseline | null => window.intenticChatgpt?.asking?.lastAnswerBaseline() ?? null;

// Turns on one of the composer's tools (Deep research, agent mode) from its menu, and reads back that it shows as
// chosen: a pill in the composer named after it, or the menu item checked when the menu is opened again.
export const modeStep = async (mode: "deep_research" | "agent", waitMs: number): Promise<StepAnswer | null> => {
    const reading = window.intenticChatgpt?.reading;
    const acting = window.intenticChatgpt?.acting;
    if (reading === undefined || acting === undefined) {
        return null;
    }
    const { site, regex, nameOf, locate } = reading;
    const answer = (ok: boolean, message: string): StepAnswer => ({ kind: "answer", ok, message });
    const wanted = regex(site.modes[mode]);
    const items = (): Element[] =>
        Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]')).filter((el) => wanted.test(nameOf(el)));
    // A pill in the composer is a button named after the tool, outside any menu.
    const chosen = (): boolean =>
        Array.from(document.querySelectorAll('form button, form [role="button"]')).some((el) => el.closest('[role="menu"]') === null && wanted.test(nameOf(el)));
    if (chosen()) {
        return answer(true, `It already shows as chosen.`);
    }
    const menuButton = locate(site.toolsMenu);
    if (menuButton === undefined) {
        return answer(false, `ChatGPT's tools button ("Add files and more") is not on the page.`);
    }
    acting.press(menuButton);
    const item = await acting.until(() => items()[0], waitMs);
    if (item === undefined) {
        acting.key(document.activeElement ?? document.body, "Escape");
        return answer(false, `ChatGPT's tools menu did not open, or has no "${site.modes[mode].source}" choice on this account.`);
    }
    acting.press(item);
    const took = await acting.until(() => chosen() || item.getAttribute("aria-checked") === "true", waitMs);
    if (items().length > 0) {
        acting.key(document.activeElement ?? document.body, "Escape");
    }
    return took === true ? answer(true, `It shows as chosen.`) : answer(false, `ChatGPT does not show it as chosen after the click.`);
};
