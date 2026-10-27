<script module>
  export const platform = /Mac/.test(navigator.userAgent) ? "mac" : /Linux/.test(navigator.userAgent) ? "linux" : "other";
</script>

<script>
  import { getCurrentWindow } from "./tauri.js";

  // A view's header bar, which doubles as the title bar (tauri.macos/linux.conf.json). macOS keeps
  // its own window buttons over it; Linux has none, so the bar carries GNOME's close button. An OSD
  // bar floats over the viewer; a flat one has no background or shadow.
  let { start, title, end, osd = false, flat = false } = $props();
</script>

<svelte:element this={osd ? "div" : "header"} class={osd ? "osd-bar" : ["headerbar", flat && "flat"]} data-tauri-drag-region="deep">
  <div class="start">{@render start?.()}</div>
  {#if title}
    <div class="window-title">{@render title()}</div>
  {/if}
  <div class="end">
    {@render end?.()}
    {#if platform === "linux"}
      <button class={["btn circular window-close", osd && "osd"]} title="Close" onclick={() => getCurrentWindow().close()}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><use href="#icon-close" /></svg>
      </button>
    {/if}
  </div>
</svelte:element>
