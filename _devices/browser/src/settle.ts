import { sleep } from "@intentic/base/async";

// WAITING FOR A PAGE TO SHOW WHAT AN ACTION DID, ON THE PAGE'S OWN SIGNALS (2026-10-20). Each wait used to be a fixed
// sleep (500 ms after an action, 600 ms after opening). Now an action's wait ends once the DOM has been quiet for a
// moment, and a navigation's once the new document has parsed (DOMContentLoaded). The old sleeps are kept as the caps,
// so no call waits longer than it did.

export const ACTION_SETTLE_MAX_MS = 500;
export const OPEN_SETTLE_MAX_MS = 600;
// How long the DOM must go without a mutation to count as done reacting: a fetch's re-render lands well within it.
const QUIET_MS = 100;
// Between tries to reach a document that does not exist yet (mid-navigation, no context to evaluate in).
const RETRY_MS = 50;

// Resolves "quiet" once the DOM has been still for QUIET_MS, or "left" at the cap when the page began navigating away
// (beforeunload, or a cross-document navigate event), which a quiet old document must not be mistaken for being done.
const quietScript = (capMs: number): string => `(function () {
  return new Promise(function (resolve) {
    var leaving = false, finished = false, quietTimer;
    function finish(how) {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      removeEventListener('beforeunload', onLeave);
      resolve(how);
    }
    function onLeave() { leaving = true; clearTimeout(quietTimer); }
    function bump() {
      clearTimeout(quietTimer);
      if (!leaving) quietTimer = setTimeout(function () { finish('quiet'); }, ${QUIET_MS});
    }
    var capTimer = setTimeout(function () { finish(leaving ? 'left' : 'cap'); }, ${capMs});
    addEventListener('beforeunload', onLeave);
    if (window.navigation) {
      window.navigation.addEventListener('navigate', function (event) {
        if (!event.destination || !event.destination.sameDocument) onLeave();
      });
    }
    var observer = new MutationObserver(bump);
    var root = document.documentElement;
    if (root) observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    bump();
  });
})()`;

// Resolves once the document has parsed, or at the cap.
const parsedScript = (capMs: number): string => `(function () {
  if (document.readyState !== 'loading') return true;
  return new Promise(function (resolve) {
    var capTimer = setTimeout(function () { resolve(false); }, ${capMs});
    document.addEventListener('DOMContentLoaded', function () { clearTimeout(capTimer); resolve(true); }, { once: true });
  });
})()`;

export interface SettleClock {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
}

// Evaluates a script in the page, answering what its promise resolved to (a string or a boolean for these scripts).
export type RunInPage = (script: string) => Promise<PageAnswer>;
export type PageAnswer = string | boolean | undefined;

const realClock: SettleClock = { now: Date.now, sleep: async (ms) => await sleep(ms) };

// Runs `script(remaining)` in the page until one answers, within `capMs`. A navigation destroys the document a script
// runs in, which comes back as an error; the next try then runs in the new document, once it exists. The retry timer is
// only for that gap, when there is no page to listen in.
const untilAnswered = async (run: RunInPage, script: (remainingMs: number) => string, capMs: number, clock: SettleClock): Promise<PageAnswer> => {
    const deadline = clock.now() + capMs;
    while (clock.now() < deadline) {
        try {
            return await run(script(Math.max(1, deadline - clock.now())));
        } catch {
            // allow(silent-catch): the document went away mid-wait (a navigation); the loop tries its successor until the cap.
            await clock.sleep(Math.min(RETRY_MS, Math.max(0, deadline - clock.now())));
        }
    }
    return undefined;
};

// After a click, a fill or a key: the DOM going quiet, or, when the action navigated, the new document parsing.
export const settleAfterAction = async (run: RunInPage, clock: SettleClock = realClock): Promise<void> => {
    const deadline = clock.now() + ACTION_SETTLE_MAX_MS;
    const outcome = await untilAnswered(run, quietScript, ACTION_SETTLE_MAX_MS, clock);
    if (outcome === "quiet" || outcome === "cap") {
        return;
    }
    await untilAnswered(run, parsedScript, deadline - clock.now(), clock);
};

// After opening a tab: its document parsing.
export const settleAfterOpen = async (run: RunInPage, clock: SettleClock = realClock): Promise<void> => {
    await untilAnswered(run, parsedScript, OPEN_SETTLE_MAX_MS, clock);
};
