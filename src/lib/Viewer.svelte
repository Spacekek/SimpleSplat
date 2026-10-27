<script>
  import HeaderBar from "./HeaderBar.svelte";
  import SplatViewer from "./SplatViewer.svelte";
  import { dirOf } from "./paths.js";
  import { revealItemInDir } from "./tauri.js";

  // A finished splat in a live viewer, with OSD buttons on top.
  let { scene, onnew } = $props();
</script>

<section id="viewer">
  <SplatViewer ply={scene} viewDir={dirOf(scene)} />
  <HeaderBar osd>
    {#snippet start()}
      <button class="btn osd pill icon-label" onclick={onnew}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10.5 2.5 5 8l5.5 5.5 1.06-1.06L7.12 8l4.44-4.44z" fill="currentColor" /></svg>
        <span>New Splat</span>
      </button>
    {/snippet}
    {#snippet end()}
      <button class="btn osd pill icon-label" onclick={() => revealItemInDir(scene)}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M1.5 4.5v8.25c0 .41.34.75.75.75h11.5c.41 0 .75-.34.75-.75V6.25a.75.75 0 0 0-.75-.75H8L6.5 3.5H2.25a.75.75 0 0 0-.75.75z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        </svg>
        <span>Show in Folder</span>
      </button>
    {/snippet}
  </HeaderBar>
</section>

<style>
  #viewer {
    position: relative;
    background: #000;
  }
</style>
