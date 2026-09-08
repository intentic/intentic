import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { Eta } from "eta";

// Templates ship beside dist/, never src/ (tsc won't copy it); anchored so both layouts resolve alike.
const views = join(packageRoot(import.meta.url), "templates");

// autoEscape off: not HTML, escaping would corrupt `${{ … }}`. autoTrim off: output is whitespace-sensitive.
const eta = new Eta({ views, autoEscape: false, autoTrim: false });

// Renders a template path under templates/ without the .eta suffix (appended here); the name still carries the real
// output extension (.yaml/.ts/.md) for readability/highlighting.
export const renderTemplate = (name: string, data: Record<string, unknown>): string => eta.render(`${name}.eta`, data);
