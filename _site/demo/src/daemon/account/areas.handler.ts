import { demoAreas, removeArea, saveArea } from "../extensions/personas";
import { type Doors, okAfter } from "../doors";

// The named parts of the workspace a grant can be fenced to; a save is real, like a persona's, so the Areas
// page edits what the Access tab's picker then offers.
export const areasDoors = {
    list: () => ({ areas: demoAreas }),
    save: (area) => okAfter(() => saveArea(area)),
    remove: ({ id }) => okAfter(() => removeArea(id)),
} satisfies Doors<`areas`>;
