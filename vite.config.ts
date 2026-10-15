import { defineConfig } from "vite";

// Tauri expects a fixed port, and rebuilds the Rust side itself.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
});
