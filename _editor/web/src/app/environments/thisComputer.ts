import { z } from "zod";
import { desktopApp, openDesktopLink } from "./desktop";

// THIS COMPUTER'S OWN SANDBOXES, WITHOUT INTENTIC (2026-10-26). The desktop app carries its own copy of the editor (its
// machine_face.rs), which opens the sandboxes running on this computer over their loopback ports with a session the
// computer mints itself, so it needs neither the platform nor the internet. The app says `machineFace: true` on its
// `__INTENTIC_DESKTOP__` only when its build has that copy AND this computer has sandboxes for it to open, so a page that
// offers the way there never sends the reader to an empty screen; an older app says nothing, and nothing is offered.
// Pressed, the link turns this window into that editor (the app's `intentic://machine-face`), the same place its own
// offline page leads. Read apart from desktop.ts's other fields, which that module types.

export const DESKTOP_MACHINE_FACE_LINK = `intentic://machine-face`;

const Offered = z.object({ machineFace: z.literal(true) });

// Whether this window can offer this computer's own sandboxes: the desktop app's workspace on a computer that runs some.
export const thisComputerOffered = (): boolean => Offered.safeParse(desktopApp()).success;

export const openThisComputersSandboxes = (): void => {
    openDesktopLink(DESKTOP_MACHINE_FACE_LINK);
};
