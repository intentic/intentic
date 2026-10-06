import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code's project-dir naming: every non-alphanumeric character of the absolute cwd becomes "-".
export const slugOf = (root: string): string => root.replace(/[^a-zA-Z0-9]/g, "-");

export const projectsDirOf = (root: string, claudeDir?: string): string => join(claudeDir ?? join(homedir(), ".claude"), "projects", slugOf(root));
