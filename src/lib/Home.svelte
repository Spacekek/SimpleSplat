<script>
  import HeaderBar from "./HeaderBar.svelte";
  import { baseName } from "./paths.js";
  import { release } from "./release.svelte.js";
  import { customCount, gpuWarning, settings } from "./settings.svelte.js";
  import { open, openUrl } from "./tauri.js";

  // The start screen: Detail and the two inputs, plus only what needs attention: a GPU memory
  // warning, a newer version, and what differs from the default settings.
  let { dragging, onchoose, onsettings, onabout } = $props();
  let menuOpen = $state(false);

  // The Settings button also says what differs from the defaults: custom settings, a chosen output folder.
  const settingsLabel = $derived.by(() => {
    const n = customCount();
    const { output, outDir } = settings.values;
    return ["Settings", n ? `${n} custom` : "", output === "folder" && outDir ? `saved in ${baseName(String(outDir))}` : ""].filter(Boolean).join(" · ");
  });

  async function choose(options) {
    const path = await open(options);
    if (typeof path === "string") onchoose(path);
  }
</script>

<svelte:document onclick={() => (menuOpen = false)} onkeydown={(e) => e.key === "Escape" && (menuOpen = false)} />

<section id="home" class={{ dragging }}>
  <HeaderBar flat>
    {#snippet end()}
      <button
        type="button"
        class="btn flat circular"
        title="Main Menu"
        aria-label="Main Menu"
        aria-haspopup="menu"
        aria-expanded={String(menuOpen)}
        onclick={(e) => {
          e.stopPropagation();
          menuOpen = !menuOpen;
        }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      {#if menuOpen}
        <div class="popover-menu" role="menu">
          <button type="button" role="menuitem" class="menu-item" onclick={onsettings}>Settings</button>
          <button type="button" role="menuitem" class="menu-item" onclick={onabout}>About SimpleSplat</button>
        </div>
      {/if}
    {/snippet}
  </HeaderBar>
  {#if release.update}
    <div class="adw-banner" role="status">
      <span>Version {release.update.version} is available (you have {release.version})</span>
      <button type="button" class="btn" onclick={() => openUrl(release.update.url)}>Download</button>
    </div>
  {/if}

  <div class="status-page">
    <svg class="status-icon" viewBox="0 0 64 64" width="128" height="128" aria-hidden="true"><use href="#app-icon" /></svg>
    <h1>SimpleSplat</h1>
    <p class="description">Turn a video or a folder of photos into a 3D scene you can look around in.</p>
    <div class="detail-picker">
      <div class="detail-row">
        <span class="detail-label">Detail</span>
        <div class="toggle-group" role="radiogroup" aria-label="Detail">
          <label><input type="radio" name="detail" value="low" bind:group={settings.values.detail} /><span>Low</span></label>
          <label><input type="radio" name="detail" value="medium" bind:group={settings.values.detail} /><span>Medium</span></label>
          <label><input type="radio" name="detail" value="high" bind:group={settings.values.detail} /><span>High</span></label>
        </div>
      </div>
      {#if gpuWarning()}
        <p class="caption warn" role="status">{gpuWarning()}</p>
      {/if}
    </div>
    <div class="buttons">
      <button class="btn pill suggested" onclick={() => choose({ filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v", "avi", "mkv", "webm"] }] })}>Choose Video…</button>
      <button class="btn pill" onclick={() => choose({ directory: true })}>Choose Photo Folder…</button>
    </div>

    <p class="caption dim">Or drop a video, a photo folder or a finished <code>.ply</code> here</p>
  </div>
  <footer class="home-footer">
    <button type="button" class="btn pill" onclick={onsettings}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        />
      </svg>
      <span>{settingsLabel}</span>
    </button>
  </footer>
</section>

<style>
  /* A status page. */
  #home {
    position: relative;
  }

  .status-page {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 0 24px 46px;
    text-align: center;
  }

  .status-icon {
    margin-bottom: 24px;
  }

  h1 {
    font-size: 2em;
    font-weight: 800;
  }

  .description {
    max-width: 36ch;
  }

  .status-page .buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
    margin-top: 24px;
  }

  /* Settings, bottom centre. */
  .home-footer {
    position: absolute;
    inset: auto 0 16px;
    display: flex;
    justify-content: center;
  }

  .home-footer .btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 18px;
    font-weight: 400;
  }

  /* Detail sits on the home screen: the one choice most runs need. */
  .detail-picker {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin-top: 16px;
  }

  .detail-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .detail-label {
    font-weight: 700;
  }

  .detail-picker .warn {
    max-width: 56ch;
  }

  /* Drop target highlight over the whole window. */
  #home.dragging::after {
    content: "";
    position: absolute;
    inset: 8px;
    border: 2px dashed var(--accent-bg);
    border-radius: 12px;
    background: color-mix(in srgb, var(--accent-bg) 8%, transparent);
    pointer-events: none;
  }
</style>
