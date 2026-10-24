<script>
  import Dialog from "./Dialog.svelte";
  import SettingRow from "./SettingRow.svelte";
  import { DETAILS, cap, detailIndex, gpuFit, gpuWarning, resetAdvanced, settings } from "./settings.svelte.js";
  import { open as openFolder } from "./tauri.js";

  // The preferences dialog. `form` is its form, whose fields check their own limits.
  let { open = $bindable(), form = $bindable() } = $props();
  const LEVELS = [
    ["off", "Off"],
    ["mild", "Mild"],
    ["strong", "Strong"],
  ];

  async function chooseOutDir() {
    const dir = await openFolder({ directory: true });
    if (typeof dir !== "string") return;
    settings.values.outDir = dir;
    settings.values.output = "folder";
  }
</script>

<Dialog bind:open id="settings" class="dialog" labelledby="settings-title">
  <header class="headerbar">
    <div class="start"></div>
    <div class="window-title"><div class="title" id="settings-title">Settings</div></div>
    <div class="end">
      <button type="button" class="btn flat circular" title="Close" aria-label="Close" onclick={() => (open = false)}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><use href="#icon-close" /></svg>
      </button>
    </div>
  </header>
  <!-- Enter in a field must not submit (and reload) the page. -->
  <form bind:this={form} class="content clamp" onsubmit={(e) => e.preventDefault()}>
    <p class="intro caption">
      <span class="dim">Defaults follow the Detail chosen on the start screen, now <strong>{cap(DETAILS[detailIndex()])}</strong>.</span>
      <span class={gpuWarning() ? "warn" : "dim"}>{gpuFit()}</span>
    </p>

    <div class="group">
      <h3 class="group-title">Results</h3>
      <div class="boxed-list">
        <label class="row">
          <input type="radio" name="output" value="next" bind:group={settings.values.output} />
          <div class="row-text">
            <div class="title">Next to the Input</div>
            <div class="subtitle">A <code>name_splat</code> folder beside the video or photo folder</div>
          </div>
        </label>
        <label class="row">
          <input type="radio" name="output" value="folder" bind:group={settings.values.output} />
          <div class="row-text">
            <div class="title">In a Chosen Folder</div>
            <input name="outDir" class="subtitle plain" readonly placeholder="No folder chosen" value={settings.values.outDir} />
          </div>
          <button type="button" class="btn" onclick={chooseOutDir}>Choose…</button>
        </label>
      </div>
    </div>

    <div class="group">
      <h3 class="group-title">Images</h3>
      <div class="boxed-list">
        <SettingRow name="frames" title="Max Images" subtitle="Photos from a folder, or frames from a video (at least half this many)" min={10} by={10} />
        <SettingRow name="fps" title="Frames per Second" subtitle="Taken from a video, within Max Images" min={0.5} step="any" by={1} />
        <SettingRow name="maxSize" title="Max Image Size" subtitle="Pixels on the long side" min={200} by={100} />
        <SettingRow name="singleCamera" title="Single Camera" subtitle="Whether every image shares one lens" options={[["true", "Yes"], ["false", "No"]]} />
        <SettingRow name="sfmQuality" title="Camera Position Quality" subtitle="Higher is more precise and slower" options={[["low", "Low"], ["medium", "Medium"], ["high", "High"]]} />
      </div>
    </div>

    <div class="group">
      <h3 class="group-title">Training</h3>
      <div class="boxed-list">
        <SettingRow name="steps" title="Training Steps" min={100} by={1000} />
        <SettingRow name="maxSplats" title="Max Splats" subtitle="More splats hold more detail, and need more GPU memory" min={10000} by={100000} />
        <SettingRow name="floaterSuppression" title="Floater Suppression" subtitle="Cleans up floating blobs and see-through surfaces" options={LEVELS} />
        <SettingRow name="ignoreMoving" title="Ignore Moving Things" subtitle="People, cars and anything else that moves between images" options={LEVELS} />
        <SettingRow name="exposureCorrection" title="Exposure Correction" subtitle="Evens out brightness and colour changes between images" />
        <SettingRow name="exportEvery" title="Preview Every" subtitle="Training steps between previews" min={100} by={500} />
      </div>
    </div>

    <div class="group">
      <h3 class="group-title">Files</h3>
      <div class="boxed-list">
        <SettingRow name="keepIntermediates" title="Keep Intermediate Files" subtitle="Makes re-runs faster" />
      </div>
    </div>

    <div class="group">
      <div class="boxed-list">
        <button type="button" class="row button-row" onclick={resetAdvanced}>Reset to Defaults</button>
      </div>
    </div>
  </form>
</Dialog>
