import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectPath = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  base: "/reshape-studio/",
  root: projectPath("./standalone"),
  publicDir: projectPath("./public"),
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: projectPath("./dist-pages"),
  },
});
