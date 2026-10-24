<script>
  import { makeViewer } from "./viewer.js";

  // A live viewer of `ply`, for as long as this component is shown. One that finishes loading after
  // it was closed (or given another file) is discarded.
  let { id, ply, viewDir } = $props();
  let host;

  $effect(() => {
    let viewer = null;
    let closed = false;
    makeViewer(host, ply, viewDir, true)
      .then((loaded) => (closed ? loaded.destroy() : (viewer = loaded)))
      .catch((err) => console.error("viewer failed", err));
    return () => {
      closed = true;
      viewer?.destroy();
    };
  });
</script>

<div {id} bind:this={host}></div>
