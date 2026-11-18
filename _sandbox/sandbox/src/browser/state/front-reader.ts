// Which tab a browser window has in front, asked of Chromium itself rather than guessed from which page last moved.
// One reader per window, whoever watches it: before this, every viewer of a window polled Chromium on its own once a
// second, and the browsers list kept a guess of its own (the page that last navigated), so a tab loading in the
// background could take the strip while the picture stayed put.
//
// Chromium says which tab is in front only when asked (front-tab.ts): no DevTools event fires on a tab switch, and a
// page cannot tell, since Playwright's focus emulation keeps every tab "visible". So the reader asks when something
// could have moved it: a tab opening or closing, a person picking one, an agent's browser call returning. A slow
// backstop asks too while someone is watching, for what none of those cover (a page focusing another window itself).

// While someone watches the window: an ask this often catches a switch nothing told the reader about.
const FRONT_BACKSTOP_MS = 2_000;

export interface FrontReader {
    // Ask again, now or after `delayMs` (a tab just opened is listed by Chromium a moment after it exists).
    readonly schedule: (delayMs?: number) => void;
    readonly stop: () => void;
}

export interface FrontReaderDeps {
    // The tab in front, by its page id; undefined when Chromium did not answer, which leaves the last answer standing.
    readonly read: () => Promise<string | undefined>;
    // Each answer, the same as the last one or not: the window knows what it had.
    readonly apply: (pageId: string) => void;
    // Whether anyone is watching the window now, which is when the backstop asks.
    readonly watched: () => boolean;
    readonly backstopMs?: number;
}

// A read that threw is one Chromium did not answer: the last answer stands, and the next ask tries again. The reader
// runs unawaited from timers and events, where a rejection would have nobody to land on.
const noAnswer = (): undefined => undefined;

export const frontReader = (deps: FrontReaderDeps): FrontReader => {
    let stopped = false;
    let running = false;
    // An ask that came while one was running: its answer may predate what moved the tab, so it is asked once more.
    let again = false;
    const timers = new Set<NodeJS.Timeout>();

    const run = async (): Promise<void> => {
        if (running) {
            again = true;
            return;
        }
        running = true;
        try {
            for (;;) {
                again = false;
                const front = await deps.read().catch(noAnswer);
                if (stopped) {
                    return;
                }
                if (front !== undefined) {
                    deps.apply(front);
                }
                if (!again) {
                    return;
                }
            }
        } finally {
            running = false;
        }
    };

    const schedule = (delayMs = 0): void => {
        if (stopped) {
            return;
        }
        if (delayMs <= 0) {
            void run();
            return;
        }
        const timer = setTimeout(() => {
            timers.delete(timer);
            void run();
        }, delayMs);
        timer.unref();
        timers.add(timer);
    };

    const backstop = setInterval(() => {
        if (deps.watched()) {
            void run();
        }
    }, deps.backstopMs ?? FRONT_BACKSTOP_MS);
    backstop.unref();

    return {
        schedule,
        stop: () => {
            stopped = true;
            clearInterval(backstop);
            for (const timer of timers) {
                clearTimeout(timer);
            }
            timers.clear();
        },
    };
};
