<script>
  import Dialog from "./Dialog.svelte";
  import { release } from "./release.svelte.js";
  import { openUrl } from "./tauri.js";

  let { open = $bindable() } = $props();
</script>

<Dialog bind:open id="about" class="dialog about" labelledby="about-name">
  <header class="headerbar">
    <div class="start"></div>
    <div class="end">
      <button type="button" class="btn flat circular" title="Close" aria-label="Close" onclick={() => (open = false)}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><use href="#icon-close" /></svg>
      </button>
    </div>
  </header>
  <div class="about-body">
    <svg viewBox="0 0 64 64" width="96" height="96" aria-hidden="true"><use href="#app-icon" /></svg>
    <h2 id="about-name">SimpleSplat</h2>
    <span class="version">{release.version}</span>
    <p class="dim">Turn a video or a folder of photos into a 3D scene you can look around in</p>
    <div class="boxed-list">
      {#if release.repo}
        <button type="button" class="row button-row" onclick={() => openUrl(`https://github.com/${release.repo}`)}>Website</button>
      {/if}
    </div>
    <p class="caption dim">Apache-2.0. Uses Spirula Studio (GPL-3.0) and FFmpeg, run as separate programs.</p>
  </div>
</Dialog>
