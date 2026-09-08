// Cloudflare Turnstile bot check: one token spent on a visitor thread's first message, then the rate limit takes over.
// Rendered into a light-DOM container since it is a third-party iframe; the secret half is verified server-side.

interface Turnstile {
    render: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "error-callback": () => void }) => void;
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let turnstileLoad: Promise<Turnstile> | undefined;

const loadTurnstile = async (): Promise<Turnstile> => {
    turnstileLoad ??= new Promise<Turnstile>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = TURNSTILE_SRC;
        script.async = true;
        script.addEventListener("load", () => {
            const turnstile = (window as unknown as { turnstile?: Turnstile }).turnstile;
            if (turnstile === undefined) {
                reject(new Error("The bot check failed to load"));
                return;
            }
            resolve(turnstile);
        });
        script.addEventListener("error", () => reject(new Error("The bot check failed to load")));
        document.head.append(script);
    });
    return turnstileLoad;
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
