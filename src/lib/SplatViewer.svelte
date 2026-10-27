<script>
  import { makeViewer } from "./viewer.js";

  // A live viewer of `ply`, filling its positioned parent, for as long as this component is shown. One
  // that finishes loading after it was closed (or given another file) is discarded.
  let { id, ply, viewDir } = $props();

  function showViewer(host) {
    let viewer = null;
    let closed = false;
    makeViewer(host, ply, viewDir, true)
      .then((loaded) => (closed ? loaded.destroy() : (viewer = loaded)))
      .catch((err) => console.error("viewer failed", err));
    return () => {
      closed = true;
      viewer?.destroy();
    };
  }
</script>

<div {id} {@attach showViewer}></div>

<style>
  div {
    position: absolute;
    inset: 0;
  }
</style>
