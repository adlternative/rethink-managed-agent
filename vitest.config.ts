import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], exclude: ["data/**", "node_modules/**", "dist/**"], watch: false },
});
