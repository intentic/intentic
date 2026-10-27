import { demoCapabilities } from "./fixture/sandbox";
import { type ClientFrame, clientFrame, pushDomains } from "./daemon/machine/machineKit";
import type { DemoSession, DemoSocket } from "./transport";
import { startVideoCast } from "./videoCast";

// One connected account's own Chromium (the daemon's browser-profile.routes.ts), opened from its card to sign in once or to
// look around signed in. The demo draws the site's sign-in page and fills its fields with what the owner types; "I'm
// done" saves the profile, as the daemon flushes it, and the account's card is told its sign-in moved.

const WIDTH = 1100;
const HEIGHT = 720;
// Flushing a Chromium profile to disk is a second or two on a real sandbox.
const SAVE_MS = 1_400;

// The accounts whose profile was saved signed in this page load, so browsing one again opens it signed in.
const signedIn = new Set<string>();

interface Page {
    readonly site: string;
    readonly field: `username` | `password`;
    username: string;
    password: string;
}

const siteOf = (capability: string): string => {
    const config = demoCapabilities().find((candidate) => candidate.id === capability)?.config;
    const platform = config?.[`platform`];
    return platform === undefined ? capability : String(platform);
};

const paintSignIn = (page: Page, browsing: boolean) => (context: OffscreenCanvasRenderingContext2D): void => {
    context.fillStyle = `#f6f7f8`;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = `#1a1a1b`;
    context.font = `600 28px system-ui, sans-serif`;
    if (browsing) {
        context.fillText(`${page.site}.com`, 80, 90);
        context.font = `16px system-ui, sans-serif`;
        context.fillText(`Signed in. This is the account's own browser: what you do here stays signed in for the agent.`, 80, 130, WIDTH - 160);
        return;
    }
    context.fillText(`Log in to ${page.site}`, 380, 170);
    const field = (label: string, value: string, y: number, active: boolean): void => {
        context.fillStyle = `#ffffff`;
        context.fillRect(380, y, 340, 46);
        context.strokeStyle = active ? `#0079d3` : `#d0d4d9`;
        context.strokeRect(380, y, 340, 46);
        context.fillStyle = value === `` ? `#878a8c` : `#1a1a1b`;
        context.font = `15px system-ui, sans-serif`;
        context.fillText(value === `` ? label : value, 396, y + 29);
    };
    field(`Username`, page.username, 220, page.field === `username`);
    field(`Password`, `•`.repeat(page.password.length), 282, page.field === `password`);
    context.fillStyle = `#d93a00`;
    context.fillRect(380, 352, 340, 44);
    context.fillStyle = `#ffffff`;
    context.font = `600 15px system-ui, sans-serif`;
    context.fillText(`Log In`, 525, 380);
};

// Typing goes to the field in focus; a click on the password box, or Tab, moves to it.
const typeInto = (page: Page, said: ClientFrame): Page => {
    if (said.type === `mouse` && said.action === `down` && Number.isFinite(said.y)) {
        return { ...page, field: Number(said.y) >= 282 ? `password` : `username` };
    }
    if (said.type === `key` && said.key === `Tab`) {
        return { ...page, field: page.field === `username` ? `password` : `username` };
    }
    if (said.type === `text`) {
        const text = String(said.text ?? ``);
        return page.field === `username` ? { ...page, username: page.username + text } : { ...page, password: page.password + text };
    }
    return page;
};

/** The account's browser over /system/browser-profile: its page as video, the owner's hands on it, and the save. */
export const profileSession: DemoSession = (socket: DemoSocket) => {
    const params = new URL(socket.url).searchParams;
    const capability = params.get(`capability`) ?? ``;
    let page: Page = { site: siteOf(capability), field: `username`, username: ``, password: `` };
    const browsing = params.get(`mode`) === `browse` || signedIn.has(capability);
    const cast = startVideoCast(socket, { width: WIDTH, height: HEIGHT }, (context) => paintSignIn(page, browsing)(context));
    socket.addEventListener(`client`, (event) => {
        const said = clientFrame(event);
        if (said.type === `ping`) {
            socket.emit(JSON.stringify({ type: `pong` }));
        } else if (said.type === `pause`) {
            cast.pause();
        } else if (said.type === `resume`) {
            cast.resume();
        } else if (said.type === `done`) {
            setTimeout(() => {
                signedIn.add(capability);
                pushDomains(`capabilities`);
                socket.emit(JSON.stringify({ type: `saved` }));
            }, SAVE_MS);
        } else {
            page = typeInto(page, said);
            cast.repaint();
        }
    });
};
