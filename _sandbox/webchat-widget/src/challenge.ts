// Cloudflare Turnstile bot check: one token spent on a visitor thread's first message, then the rate limit takes over.
// Rendered into a light-DOM container since it is a third-party iframe; the secret half is verified server-side.

interface Turnstile {
    render: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "error-callback": () => void }) => void;
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// One load per page while it works. A failed one is not kept: a blocked or flaky first fetch would otherwise cost the
// visitor the chat until a reload, and opening the panel again is what retries it.
let turnstileLoad: Promise<Turnstile> | undefined;

// Adds the script tag and resolves with Cloudflare's global once it has run.
const injectTurnstile = (): Promise<Turnstile> =>
    new Promise<Turnstile>((resolve, reject) => {
        const script = document.createElement("script");
        const fail = (): void => {
            // The retry adds a fresh tag; a dead one left behind would only pile up.
            script.remove();
            reject(new Error("The bot check failed to load"));
        };
        script.src = TURNSTILE_SRC;
        script.async = true;
        script.addEventListener("load", () => {
            const turnstile = (window as unknown as { turnstile?: Turnstile }).turnstile;
            if (turnstile === undefined) {
                fail();
                return;
            }
            resolve(turnstile);
        });
        script.addEventListener("error", fail);
        document.head.append(script);
    });

const loadTurnstile = async (): Promise<Turnstile> => {
    turnstileLoad ??= injectTurnstile();
    const load = turnstileLoad;
    try {
        return await load;
    } catch (error) {
        if (turnstileLoad === load) {
            turnstileLoad = undefined;
        }
        throw error;
    }
};

export const solveTurnstile = async (container: HTMLElement, siteKey: string): Promise<string> => {
    const turnstile = await loadTurnstile();
    return new Promise<string>((resolve, reject) => {
        turnstile.render(container, {
            sitekey: siteKey,
            callback: resolve,
            "error-callback": () => reject(new Error("Bot check failed. Reload the page.")),
        });
    });
};
