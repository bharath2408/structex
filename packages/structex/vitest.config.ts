import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    // Legacy decorators are required for parameter decorators (@Body(), etc).
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        target: "ES2022",
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
