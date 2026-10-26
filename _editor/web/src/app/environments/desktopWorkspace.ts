import { desktopVersion } from "./desktop";
import { localFace, sandboxFace } from "./local";

/* THE DESKTOP APP'S WORKSPACE FACE: the hosted editor the app shows for an account, which is neither one of its local
   windows on a folder (local.ts `localFace`) nor its offline face on this computer's own sandboxes (`sandboxFace`). It is
   the one window of the app with a sign-in to ask for, and it asks in a dialog over whatever it shows rather than on a
   screen of its own (features/auth/signInDialog.ts): the app has no address bar and no back button, so a reader sent to a
   full-window sign-in had lost the view they were on, and a new one met it before anything else. */
export const desktopWorkspace = (): boolean => desktopVersion() !== undefined && localFace() === undefined && !sandboxFace();
