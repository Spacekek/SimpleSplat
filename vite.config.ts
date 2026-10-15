import { defineConfig } from "vite";

// Tauri expects a fixed port, and rebuilds the Rust side itself.
export default defineConfig({
  clearScreen: false,
  // Set in GitHub's CI, so release builds can look for newer releases; empty elsewhere.
  define: { __REPO__: JSON.stringify(process.env.GITHUB_REPOSITORY ?? "") },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
});
