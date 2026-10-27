<script>
  import HeaderBar from "./HeaderBar.svelte";
  import SplatViewer from "./SplatViewer.svelte";
  import { job, stopJob } from "./job.svelte.js";
  import { makeViewer } from "./viewer.js";

  // Making a splat: the latest preview fills the window, the stages run side by side along the
  // bottom. `captureHost` is an off-screen element to render previews in.
  let { captureHost } = $props();
  let canvas;
  let previewShown = $state(false);
  let exploring = $state(""); // the preview open in a live viewer, if any
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  // The expected finish, as a time of day.
  const timeLeft = $derived.by(() => {
    if (!job.finishAt) return "";
    if (job.finishAt - now < 60_000) return " · almost ready";
    return ` · ready around ${new Date(job.finishAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  });

  // A live viewer keeps rendering, which slows training down, so previews are stills: load the
  // export off-screen, capture one frame, and tear the viewer down again.
  let capturing = Promise.resolve();
  $effect(() => {
    const ply = job.latestPreview;
    if (!ply) return;
    capturing = capturing.then(async () => {
      if (ply !== job.latestPreview) return; // a newer export arrived while we waited
      // Everything inside the try: a rejection would skip every later capture in the chain.
      let viewer;
      try {
        viewer = await makeViewer(captureHost, ply, job.projectDir, false);
        const { width, height, data } = await viewer.captureFrame({ width: canvas.width, height: canvas.height });
        const pixels = Uint8ClampedArray.from(atob(data), (c) => c.charCodeAt(0));
        canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
        previewShown = true;
      } catch (err) {
        console.error("preview failed", err);
      } finally {
        viewer?.destroy();
      }
    });
  });
</script>

<section id="progress">
  <HeaderBar>
    {#snippet title()}
      <div class="title">Making Splat</div>
      <div class="subtitle"><span>{job.name}</span><span>{timeLeft}</span></div>
    {/snippet}
    {#snippet end()}
      <button class="btn icon-label" title="Stop making the splat" disabled={job.stopping} onclick={stopJob}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" /></svg>
        <span>{job.stopping ? "Stopping…" : "Stop"}</span>
      </button>
    {/snippet}
  </HeaderBar>
  <div class="progress-body">
    <div class="preview">
      <canvas id="preview-canvas" width="800" height="450" bind:this={canvas}></canvas>
      {#if !previewShown}
        <p class="preview-empty dim">A preview appears here once training is under way</p>
      {/if}
      {#if exploring}
        <SplatViewer id="explore-host" ply={exploring} viewDir={job.projectDir} />
      {/if}
      <div class="explore-bar">
        {#if exploring}
          <p class="osd-label">Training is slower while you explore</p>
        {/if}
        {#if job.latestPreview}
          <button class="btn osd pill" onclick={() => (exploring = exploring ? "" : job.latestPreview)}>{exploring ? "Close" : "Explore"}</button>
        {/if}
      </div>
    </div>
    {#if job.notes}
      <p class="notes caption" role="status">{job.notes}</p>
    {/if}
  </div>
  <ol class="steps" aria-live="polite">
    {#each job.stages as stage}
      <li class="step" data-state={stage.state}>
        <div class="step-head"><span class="status"></span><span class="label">{stage.name}</span></div>
        <progress max="1" value={stage.fraction}></progress>
        <div class="caption what">{stage.what}</div>
        <div class="caption details">
          {#each stage.details as detail}
            <div>{detail}</div>
          {/each}
        </div>
      </li>
    {/each}
  </ol>
</section>

<style>
  .progress-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 24px 12px;
  }

  .notes {
    text-align: center;
  }

  /* Each step has its own bar, and the grid lines the bars up as one. */
  .steps {
    flex: none;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
    margin: 0;
    padding: 12px 24px 16px;
    list-style: none;
    background: var(--headerbar-bg);
    box-shadow: 0 -1px var(--shade);
  }

  .step-head {
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
  }

  .step-head .label {
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 700;
  }

  .step .caption {
    opacity: 0.55;
  }

  .status {
    flex: none;
    box-sizing: border-box;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--fill-hover);
    display: grid;
    place-items: center;
  }

  li[data-state="running"] .status {
    border-color: var(--fill-hover);
    border-top-color: currentColor;
    animation: spin 0.8s linear infinite;
  }

  li[data-state="done"] .status {
    border: 0;
    background: var(--accent-bg);
  }

  li[data-state="done"] .status::after {
    content: "";
    width: 9px;
    height: 5px;
    margin-top: -2px;
    border: solid white;
    border-width: 0 0 2px 2px;
    transform: rotate(-45deg);
  }

  li[data-state="pending"] .step-head {
    opacity: 0.55;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    li[data-state="running"] .status {
      animation-duration: 3s;
    }
  }

  .preview {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
    border-radius: 12px;
    background: var(--card-bg);
    box-shadow: var(--card-shadow);
  }

  #preview-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  :global(#explore-host:empty) {
    display: none;
  }

  .preview-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    text-align: center;
  }

  /* Explore, bottom centre over the preview, with its note above it. */
  .explore-bar {
    position: absolute;
    left: 50%;
    bottom: 16px;
    z-index: 2;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
</style>
