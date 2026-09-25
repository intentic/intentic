import type { Locator } from "playwright";
import type { Session } from "./session.js";

// Fake ms every page gets before its window opens: the featured run replays its recording until it parks on the plan
// card at about 3 s, and the shell's idle-time view prefetch has long finished by then.
const SETTLE_MS = 6_000;
// Fake ms after the last input for the debounced work it scheduled (draft snapshots, tooltips) to run inside the window.
const TAIL_MS = 1_000;
// Fake ms between keystrokes: a fast typist.
const KEY_MS = 100;
/** What chat-typing types, one key per character. */
export const TYPED = "the plan looks right";
/** How long agents-idle watches the board, and the shared clock's tick it steps by. */
export const IDLE_MS = 15_000;
export const TICK_MS = 1_000;

export interface Scenario {
    readonly name: string;
    /** The interaction, in the words of the finding it guards where there is one. */
    readonly about: string;
    /** Brings a fresh session to where the window opens; not counted. */
    readonly prepare: (session: Session) => Promise<void>;
    /** The counted interaction. */
    readonly act: (session: Session) => Promise<void>;
    /** Main-frame navigations `act` makes itself. */
    readonly navigations: number;
    /** False when `act` renders while modules still arrive, so wall time decides how many frames its layouts share. */
    readonly frames: boolean;
}

/**
 * Hovers the target before the window opens: a locator click inside it would run Playwright's actionability polling in
 * the page, and the hover's restyle belongs to the pointer arriving, not to the press.
 */
const aim = async (session: Session, target: Locator): Promise<void> => {
    const box = await target.boundingBox();
    if (box === null) {
        throw new Error(`nothing to press: ${String(target)}`);
    }
    await session.page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    await session.quiesce();
};

/** Presses where `aim` left the pointer, then lets the press's own timers run. */
const press = async (session: Session): Promise<void> => {
    await session.page.mouse.down();
    await session.page.mouse.up();
    await session.advance(TAIL_MS);
};

export const SCENARIOS: readonly Scenario[] = [
    {
        name: "agents-cold",
        about: "load /demo/agents into an empty document and let it settle: every module, mount and first fetch",
        prepare: (session) => session.blank(),
        act: (session) => session.open("/demo/agents", SETTLE_MS),
        navigations: 1,
        // One run in eight laid out 46 times instead of 44 when a module landed across a frame; its DOM never moved.
        frames: false,
    },
    {
        name: "agents-idle",
        about: "15 s of nothing on the fleet board, where one running card arms the shared clock (useNow)",
        prepare: (session) => session.open("/demo/agents", SETTLE_MS),
        // One step per tick of the shared clock, so each tick's redraw is laid out on its own.
        act: (session) => session.advance(IDLE_MS, TICK_MS),
        navigations: 0,
        frames: true,
    },
    {
        name: "agents-to-workspace",
        about: "press the rail's Workspace tile on the fleet board: one route switch between two heavy views",
        prepare: async (session) => {
            await session.open("/demo/agents", SETTLE_MS);
            await aim(session, session.page.getByRole("link", { name: /^Workspace\b/u }));
        },
        act: press,
        navigations: 0,
        frames: true,
    },
    {
        name: "chat-typing",
        about: `type "${TYPED}" into the composer of a titled chat with four chats open (the draft-as-dependency findings)`,
        prepare: async (session) => {
            await session.open("/demo/chat", SETTLE_MS);
            const composer = session.page.getByRole("textbox", { name: /^Reply to revise the plan/u });
            await composer.click();
            await session.quiesce();
        },
        act: async (session) => {
            for (const key of TYPED) {
                await session.page.keyboard.press(key === " " ? "Space" : key);
                await session.advance(KEY_MS);
            }
            await session.advance(TAIL_MS);
        },
        navigations: 0,
        frames: true,
    },
    {
        name: "workspace-open-file",
        about: "open README.md from the workspace file tree",
        prepare: async (session) => {
            await session.open("/demo/workspace", SETTLE_MS);
            await aim(session, session.page.getByRole("treeitem", { name: "README.md" }));
        },
        act: press,
        navigations: 0,
        frames: true,
    },
    {
        name: "appearance-dark",
        about: "switch Settings → Appearance from System to Dark: a restyle of the whole document",
        prepare: async (session) => {
            await session.open("/demo/settings/appearance", SETTLE_MS);
            await aim(session, session.page.getByRole("tab", { name: "Dark", exact: true }));
        },
        act: press,
        navigations: 0,
        frames: true,
    },
];
