import { defineConfig } from "vitest/config";
import { extensionProjects } from "@intentic/testing/vitest";

export default defineConfig({ test: extensionProjects() });
