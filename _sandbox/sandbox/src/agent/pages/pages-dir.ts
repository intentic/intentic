import { stateRelPath } from "../../state-paths.js";

// Where every page a chat showed is stored, workspace-relative with its trailing slash: what the page routes take a
// page's path to start with, and the root they resolve it inside.
export const PAGES_DIR = `${stateRelPath(".intentic/records/artifacts/", "pages")}/`;
