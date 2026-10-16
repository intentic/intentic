import { oneLinerFits } from "@intentic/constants";
import type { CommandOs } from "@intentic/ui";
import { oneLiner } from "../../../app/environments/scriptCommand";

// The update one-liner for a sandbox installed by hand, run on the device that runs it: it fetches the current ic
// first, and names the sandbox, since a device running several refuses the bare verb. `ic sandbox update` is printed
// only when the page cannot know the name.
export const updateCommand = (slug: string | undefined, os: CommandOs): string =>
    slug !== undefined && oneLinerFits(`update`, [slug]) ? oneLiner(`update`, [slug], os) : `ic sandbox update`;
