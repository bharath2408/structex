import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // Required for `npx structex` to execute directly.
  banner: { js: "#!/usr/bin/env node" },
});
