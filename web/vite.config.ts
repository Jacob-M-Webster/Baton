import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The code view (CodeMirror and its languages) is one lazy chunk of about 240 kB gzipped, loaded on first use.
  build: { chunkSizeWarningLimit: 800 },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", ws: true },
    },
  },
});
