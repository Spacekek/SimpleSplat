import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { createViewer } from "@playcanvas/supersplat-viewer/viewer";
import { defaultSettings } from "@playcanvas/supersplat-viewer/settings";
import "@playcanvas/supersplat-viewer/viewer.css";

/** Mirrors pipeline::Event. */
type JobEvent =
  | { kind: "project"; path: string }
  | { kind: "stage"; n: number; name: string; skipped: boolean }
  | { kind: "stageDone"; n: number; secs: number }
  | { kind: "info"; text: string }
  | { kind: "steps"; iter: number; total: number }
  | { kind: "preview"; path: string };
type Viewer = Awaited<ReturnType<typeof createViewer>>;
type View = "home" | "progress" | "viewer" | "settings";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (view: View) => (document.body.dataset.view = view);
const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

// Settings: the form is the source of truth, remembered between launches.
const form = $<HTMLFormElement>("settings-form");
const fields = () => [...form.elements].filter((el): el is HTMLInputElement => "name" in el && !!(el as HTMLInputElement).name);
try {
  const saved = JSON.parse(localStorage.getItem("settings") ?? "{}");
  for (const el of fields()) {
    if (!(el.name in saved)) continue;
    if (el.type === "checkbox") el.checked = saved[el.name];
    else if (el.type === "radio") el.checked = el.value === saved[el.name];
    else el.value = saved[el.name];
  }
} catch {}
function values(): Record<string, string | boolean> {
  const v: Record<string, string | boolean> = {};
  for (const el of fields()) {
    if (el.type === "checkbox") v[el.name] = el.checked;
    else if (el.type !== "radio" || el.checked) v[el.name] = el.value;
  }
  return v;
}
form.addEventListener("change", () => {
  try {
    localStorage.setItem("settings", JSON.stringify(values()));
  } catch {}
});
$("open-settings").onclick = () => show("settings");
$("close-settings").onclick = () => show("home");
$("choose-out").onclick = async () => {
  const dir = await open({ directory: true });
  if (typeof dir !== "string") return;
  (form.elements.namedItem("outDir") as HTMLInputElement).value = dir;
  (form.elements.namedItem("output") as RadioNodeList).value = "folder";
  form.dispatchEvent(new Event("change"));
};

function request(input: string) {
  const v = values();
  const num = (k: string) => (v[k] ? Number(v[k]) : undefined);
  return {
    input,
    detail: v.detail,
    outDir: v.output === "folder" && v.outDir ? v.outDir : undefined,
    frames: num("frames"),
    steps: num("steps"),
    maxSize: num("maxSize"),
    exportEvery: num("exportEvery"),
    singleCamera: v.singleCamera === "" ? undefined : v.singleCamera === "true",
    incrementalMapper: v.incrementalMapper,
    keepIntermediates: v.keepIntermediates,
  };
}

// Viewers. The camera starts at the first frame's pose when the pipeline wrote view.json.
async function makeViewer(container: HTMLElement, ply: string, viewDir: string, ui: boolean) {
  const settings = defaultSettings("object");
  const view = await fetch(convertFileSrc(`${viewDir}/view.json`))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (view) settings.cameras = [{ initial: view }];
  return createViewer({ container, settings, contentUrl: convertFileSrc(ply), contentFilename: "scene.ply", ui });
}

let mainViewer: Viewer | null = null;
let scenePath = "";
async function openViewer(ply: string, viewDir: string) {
  mainViewer?.destroy();
  scenePath = ply;
  show("viewer");
  mainViewer = await makeViewer($("viewer-host"), ply, viewDir, true);
}
$("reveal").onclick = () => revealItemInDir(scenePath);
$("new").onclick = () => {
  mainViewer?.destroy();
  mainViewer = null;
  show("home");
};

// A job: progress view, still previews, optional live exploring.
let projectDir = "";
let latestPreview = "";
let explorer: Viewer | null = null;
const log = (line: string) => ($("log").textContent += line + "\n");

async function begin(path: string) {
  $("error").hidden = true;
  if (path.toLowerCase().endsWith(".ply")) {
    await invoke("allow_folder", { path });
    return openViewer(path, dirOf(path));
  }
  projectDir = latestPreview = "";
  $("stages").replaceChildren();
  $("log").textContent = $("steps-text").textContent = "";
  $<HTMLProgressElement>("steps-bar").hidden = true;
  $<HTMLCanvasElement>("preview-canvas").getContext("2d")!.clearRect(0, 0, 800, 450);
  $<HTMLButtonElement>("explore").disabled = true;
  $<HTMLButtonElement>("stop").disabled = false;
  $("stop").textContent = "Stop";
  show("progress");
  if (!(await isPermissionGranted().catch(() => true))) requestPermission().catch(() => {});
  invoke("start", { request: request(path) }).catch((err) => fail(String(err)));
}

function fail(message: string) {
  closeExplorer();
  $("error-text").textContent = message;
  $("error").hidden = false;
  show("home");
}
$("error-log").onclick = () => {
  const log = $("error-text").textContent?.split("Details: ")[1]?.trim();
  if (log) revealItemInDir(log);
};

listen<JobEvent>("job", ({ payload: e }) => {
  const stages = $("stages");
  switch (e.kind) {
    case "project":
      projectDir = e.path;
      log(`Project folder: ${e.path}`);
      break;
    case "stage": {
      const li = document.createElement("li");
      li.dataset.n = String(e.n);
      li.dataset.state = e.skipped ? "done" : "running";
      li.textContent = e.skipped ? `${e.name} (already done)` : `${e.name}…`;
      stages.append(li);
      log(li.textContent);
      break;
    }
    case "stageDone": {
      const li = stages.querySelector<HTMLElement>(`[data-n="${e.n}"]`);
      if (li) {
        li.dataset.state = "done";
        li.firstChild!.textContent = li.firstChild!.textContent!.replace(/…$/, ` (${e.secs}s)`);
      }
      $<HTMLProgressElement>("steps-bar").hidden = true;
      $("steps-text").textContent = "";
      log(`done in ${e.secs}s`);
      break;
    }
    case "info": {
      const span = Object.assign(document.createElement("span"), { className: "info", textContent: e.text });
      stages.lastElementChild?.append(span);
      log(e.text);
      break;
    }
    case "steps": {
      const bar = $<HTMLProgressElement>("steps-bar");
      bar.hidden = false;
      bar.max = e.total;
      bar.value = e.iter;
      $("steps-text").textContent = `${e.iter.toLocaleString()} of ${e.total.toLocaleString()} training steps`;
      break;
    }
    case "preview":
      latestPreview = e.path;
      $<HTMLButtonElement>("explore").disabled = false;
      log(`preview: ${e.path}`);
      capturePreview(e.path);
      break;
  }
});

listen<{ Ok: string } | { Err: string }>("job-end", ({ payload }) => {
  closeExplorer();
  if ("Ok" in payload) openViewer(payload.Ok, dirOf(payload.Ok));
  else if (payload.Err === "Stopped.") show("home");
  else fail(payload.Err);
});

$("stop").onclick = () => {
  $<HTMLButtonElement>("stop").disabled = true;
  $("stop").textContent = "Stopping…";
  invoke("stop");
};

// A live viewer keeps rendering and slowed training by 16% in the spike, so previews are stills:
// load the export off-screen, capture one frame, and tear the viewer down again.
let capturing: Promise<void> = Promise.resolve();
function capturePreview(ply: string) {
  capturing = capturing.then(async () => {
    if (ply !== latestPreview) return; // a newer export arrived while we waited
    const viewer = await makeViewer($("capture-host"), ply, projectDir, false);
    try {
      const { width, height, data } = await viewer.captureFrame({ width: 800, height: 450 });
      const pixels = Uint8ClampedArray.from(atob(data), (c) => c.charCodeAt(0));
      $<HTMLCanvasElement>("preview-canvas").getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
    } catch (err) {
      log(`preview failed: ${err}`);
    } finally {
      viewer.destroy();
    }
  });
}

$("explore").onclick = async () => {
  if (explorer) return closeExplorer();
  if (!latestPreview) return;
  $("explore").textContent = "Close";
  $("explore-note").hidden = false;
  explorer = await makeViewer($("explore-host"), latestPreview, projectDir, true);
};
function closeExplorer() {
  explorer?.destroy();
  explorer = null;
  $("explore-host").replaceChildren();
  $("explore").textContent = "Explore";
  $("explore-note").hidden = true;
}

// Input: drag and drop onto the window, or the choose buttons.
getCurrentWebview().onDragDropEvent(({ payload }) => {
  document.body.classList.toggle("dragging", payload.type === "enter" || payload.type === "over");
  const idle = document.body.dataset.view === "home" || document.body.dataset.view === "viewer";
  if (payload.type === "drop" && payload.paths[0] && idle) begin(payload.paths[0]);
});
$("choose-video").onclick = async () => {
  const path = await open({ filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v", "avi", "mkv", "webm"] }] });
  if (typeof path === "string") begin(path);
};
$("choose-folder").onclick = async () => {
  const path = await open({ directory: true });
  if (typeof path === "string") begin(path);
};
