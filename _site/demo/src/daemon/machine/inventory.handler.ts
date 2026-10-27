import { addInventory, inventoryList, removeInventory } from "./infrastructure";
import type { Doors } from "../doors";

// What deploy.config.ts declares, rewritten whole on each add or remove and answered with the new list (infrastructure.ts).
export const inventoryDoors = {
    list: inventoryList,
    add: addInventory,
    remove: ({ name }) => removeInventory(name),
} satisfies Doors<`inventory`>;
