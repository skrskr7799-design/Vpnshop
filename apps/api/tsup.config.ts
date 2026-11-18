import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  // shared отдаётся исходниками, поэтому вшиваем его в бандл
  noExternal: ["@vpn/shared"],
});
