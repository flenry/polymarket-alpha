import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/pipeline.ts", "src/db/schema.ts"],
      thresholds: {
        "src/signals/**": { lines: 90, branches: 90 },
        "src/db/queries/**": { lines: 80, branches: 80 },
        "src/sources/**": { lines: 70 },
        "src/processors/**": { lines: 80 },
      },
    },
  },
});
