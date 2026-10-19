import { z } from "zod";
import type { KeyringOp, KeyringRequest, KeyringResponse } from "../protocol.js";

// THE APP CHIP (2026-10-19): while the person lets Passwords remember what they type in programs, the session helper
// watches which field has the keyboard's focus (watch-windows.ts, watch-linux.ts). When it is a password field, a small
// "Fill with Intentic" chip shows under it if an entry is saved for that program, "Save with Intentic" if none is. A click
// asks the keyring to `fill-window`: the keyring asks the person (a Hello tap) and types the saved value, or, with
// nothing saved, shows its own type-once box, saves what is typed and types it. The chip goes when focus moves or after
// eight seconds. Nothing here reads a field's value or hooks the keyboard: what a watcher reports is a program, whether
// the field is a password field, and where it is on screen.

export const CHIP_SECONDS = 8;
export const FILL_LABEL = "Fill with Intentic";
export const SAVE_LABEL = "Save with Intentic";

// One focus change, as a watcher reports it.
export const FocusEventSchema = z
    .object({
        event: z.literal("focus"),
        password: z.boolean(),
        // The focused program's executable path (or its name, where the path cannot be read).
        path: z.string().max(1000),
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
    })
    .strict();
export type FocusEvent = z.infer<typeof FocusEventSchema>;

export const WatchEventSchema = z.discriminatedUnion("event", [FocusEventSchema, z.object({ event: z.literal("click") }).strict()]);
export type WatchEvent = z.infer<typeof WatchEventSchema>;

// Where the chip goes: just under the field's left edge.
export interface ChipPlace {
    readonly x: number;
    readonly y: number;
}

export interface ChipSurface {
    readonly show: (label: string, at: ChipPlace) => void;
    readonly hide: () => void;
}

export type AskKeyring = (request: KeyringRequest) => Promise<KeyringResponse<KeyringOp> | undefined>;

export interface ChipDeps {
    readonly ask: AskKeyring;
    readonly surface: ChipSurface;
    readonly log: (message: string) => void;
    // Runs `run` after `ms`, answering how to cancel it. A test passes its own clock.
    readonly after?: (ms: number, run: () => void) => () => void;
}

const realAfter = (ms: number, run: () => void): (() => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
};

/** The program as the keyring's origins name it: its file name, which is what an entry's `program` rule holds. Pure. */
export const programOf = (path: string): string => path.split(/[\\/]/u).pop() ?? path;

const CandidatesSchema = z.object({ ok: z.literal(true), matches: z.array(z.unknown()) });

export class ChipController {
    readonly #deps: ChipDeps;
    #cancel: (() => void) | undefined;
    // Which focus the chip on screen is for; a later focus makes an earlier answer stale.
    #turn = 0;
    #shown = false;

    constructor(deps: ChipDeps) {
        this.#deps = deps;
    }

    get shown(): boolean {
        return this.#shown;
    }

    #hide(): void {
        this.#cancel?.();
        this.#cancel = undefined;
        if (this.#shown) {
            this.#shown = false;
            this.#deps.surface.hide();
        }
    }

    async onEvent(event: WatchEvent): Promise<void> {
        if (event.event === "click") {
            await this.onClick();
            return;
        }
        await this.onFocus(event);
    }

    async onFocus(event: FocusEvent): Promise<void> {
        const turn = ++this.#turn;
        this.#hide();
        if (!event.password) {
            return;
        }
        const program = programOf(event.path);
        const answer = await this.#deps.ask({ op: "candidates", origin: { kind: "program", program } });
        if (turn !== this.#turn) {
            return;
        }
        const matches = CandidatesSchema.safeParse(answer);
        const label = matches.success && matches.data.matches.length > 0 ? FILL_LABEL : SAVE_LABEL;
        this.#shown = true;
        this.#deps.surface.show(label, { x: Math.round(event.x), y: Math.round(event.y + event.height + 2) });
        this.#cancel = (this.#deps.after ?? realAfter)(CHIP_SECONDS * 1000, () => this.#hide());
    }

    async onClick(): Promise<void> {
        if (!this.#shown) {
            return;
        }
        this.#turn++;
        this.#hide();
        const answer = await this.#deps.ask({ op: "fill-window" });
        this.#deps.log(answer === undefined ? "the chip's fill had no answer" : answer.ok ? "the chip filled a field" : `the chip's fill was refused (${answer.code})`);
    }
}
