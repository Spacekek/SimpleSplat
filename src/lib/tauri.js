// Tauri's JavaScript API, which the app itself provides (withGlobalTauri in tauri.conf.json).
export const { getVersion } = window.__TAURI__.app;
export const { convertFileSrc, invoke } = window.__TAURI__.core;
export const { listen } = window.__TAURI__.event;
export const { getCurrentWebview } = window.__TAURI__.webview;
export const { getCurrentWindow } = window.__TAURI__.window;
export const { open } = window.__TAURI__.dialog;
export const { openUrl, revealItemInDir } = window.__TAURI__.opener;
