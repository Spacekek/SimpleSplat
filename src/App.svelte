<script>
  import { flushSync } from "svelte";
  import AboutDialog from "./lib/AboutDialog.svelte";
  import ErrorDialog from "./lib/ErrorDialog.svelte";
  import { platform } from "./lib/HeaderBar.svelte";
  import Home from "./lib/Home.svelte";
  import Progress from "./lib/Progress.svelte";
  import SettingsDialog from "./lib/SettingsDialog.svelte";
  import Viewer from "./lib/Viewer.svelte";
  import { startJob } from "./lib/job.svelte.js";
  import { request } from "./lib/settings.svelte.js";
  import { getCurrentWebview, invoke, listen } from "./lib/tauri.js";

  let view = $state("home"); // "home", "progress" or "viewer"
  let scene = $state(""); // the .ply the viewer shows
  let settingsOpen = $state(false);
  let aboutOpen = $state(false);
  let error = $state(null); // a failed run: { text, log }
  let dragging = $state(false);
  let settingsForm = $state();
  let captureHost = $state();

  // The header bars adapt to the platform (adwaita.css).
  document.body.dataset.platform = platform;

  // A video or photo folder starts a job; a finished .ply opens in the viewer.
  async function begin(path) {
    error = null;
    if (path.toLowerCase().endsWith(".ply")) {
      await invoke("allow_folder", { path });
      return openScene(path);
    }
    // Nothing else checks the advanced fields' limits: the form is never submitted.
    if (!settingsForm.checkValidity()) {
      flushSync(() => (settingsOpen = true));
      settingsForm.reportValidity();
      return;
    }
    view = "progress"; // which closes the viewer: a live one would slow training down
    startJob(path, request(path)).catch((err) => fail(String(err)));
  }

  function openScene(ply) {
    scene = ply;
    view = "viewer";
  }

  // Pipeline errors end with "\nDetails: <log path>"; the path goes behind the Show Log button.
  function fail(message) {
    const [text, log = ""] = message.split("\nDetails: ");
    error = { text, log: log.trim() };
    view = "home";
  }

  // The job's result: { Ok: scene path } or { Err: message }.
  listen("job-end", ({ payload }) => {
    if ("Ok" in payload) openScene(payload.Ok);
    else if (payload.Err === "Stopped.") view = "home";
    else fail(payload.Err);
  });

  getCurrentWebview().onDragDropEvent(({ payload }) => {
    dragging = payload.type === "enter" || payload.type === "over";
    if (payload.type === "drop" && payload.paths[0] && view !== "progress") begin(payload.paths[0]);
  });
</script>

{#if view === "home"}
  <Home {dragging} onchoose={begin} onsettings={() => (settingsOpen = true)} onabout={() => (aboutOpen = true)} />
{:else if view === "progress"}
  <Progress {captureHost} />
{:else}
  <Viewer {scene} onnew={() => (view = "home")} />
{/if}
<SettingsDialog bind:open={settingsOpen} bind:form={settingsForm} />
<ErrorDialog bind:error />
<AboutDialog bind:open={aboutOpen} />
<!-- Off-screen, where previews are rendered to be captured. -->
<div id="capture-host" bind:this={captureHost}></div>

<style>
  /* Each view fills the window. */
  :global(body > section) {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    height: 100%;
  }

  /* The capture viewer needs a real size to render. */
  #capture-host {
    position: fixed;
    left: -10000px;
    top: 0;
    width: 800px;
    height: 450px;
  }
</style>
