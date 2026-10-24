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
