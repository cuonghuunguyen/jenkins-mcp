import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@cuonghuunguyen/jenkins-core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
