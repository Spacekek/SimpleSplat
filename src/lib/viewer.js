import { createViewer } from "@playcanvas/supersplat-viewer/viewer";
import { defaultSettings } from "@playcanvas/supersplat-viewer/settings";
import { convertFileSrc } from "./tauri.js";

// A SuperSplat viewer for `ply` in `container`. The camera starts at the first frame's pose when the
// pipeline wrote view.json in `viewDir`; the viewer's automatic turntable starts paused.
export async function makeViewer(container, ply, viewDir, ui) {
  const settings = defaultSettings("object");
  const view = await fetch(convertFileSrc(`${viewDir}/view.json`))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (view) settings.cameras = [{ initial: view }];
  const viewer = await createViewer({ container, settings, contentUrl: convertFileSrc(ply), contentFilename: "scene.ply", ui, noanim: true });
  // Start in orbit mode (drag to look around); the play button still runs the turntable.
  viewer.events.once("loaded:changed", () => (viewer.state.cameraMode = "orbit"));
  return viewer;
}
