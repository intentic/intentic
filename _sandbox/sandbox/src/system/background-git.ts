import { withGitCaller } from "@intentic/base/git";

// What a background loop's git is counted under (gitRunCallers): `bg <name>`, as a request's is `http <route>` (app.ts).
// Started inside it, a loop's timers and watchers carry the name into every pass they run, however much later, so one
// wrap where the loop starts names all of it. Before, it all read `unlabelled`: about a twelfth of the daemon's git on
// 2026-11-06. A name is a word the code spells, never an id or a path, so the count stays as small as the code.
export const inBackground = <T>(name: string, start: () => T): T => withGitCaller(`bg ${name}`, start);
