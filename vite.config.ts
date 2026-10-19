
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@assets": path.resolve(root, "public")
    },
    dedupe: ["react", "react-dom"]
  },

  build: {
    outDir: "dist/public",
    emptyOutDir: true
  },

  server: {
    host: "0.0.0.0",
    port: 3000
  }
});
