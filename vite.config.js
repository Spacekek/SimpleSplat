import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri expects a fixed port, and rebuilds the Rust side itself.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  // PlayCanvas alone is about 2 MB, and the app loads it from disk.
  build: { chunkSizeWarningLimit: 3000 },
});
