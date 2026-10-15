import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
const baseName = (path: string) => path.replace(/^.*[\\/]/, "");

// The header bars double as the title bar (tauri.macos/linux.conf.json). macOS keeps its own
// window buttons over them; Linux has none, so add GNOME's close button to each bar.
const platform = /Mac/.test(navigator.userAgent) ? "mac" : /Linux/.test(navigator.userAgent) ? "linux" : "other";
document.body.dataset.platform = platform;
if (platform === "linux") {
  for (const end of document.querySelectorAll(".headerbar .end, .osd-bar .end")) {
    const close = document.createElement("button");
    close.className = `btn circular window-close ${end.closest(".osd-bar") ? "osd" : ""}`;
    close.title = "Close";
    close.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    close.onclick = () => getCurrentWindow().close();
    end.append(close);
  }
}

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
function updateSummary() {
  const v = values();
  const detail = String(v.detail).replace(/^./, (c) => c.toUpperCase());
  const where = v.output === "folder" && v.outDir ? `saved in ${baseName(String(v.outDir))}` : "saved next to the input";
  $("summary").textContent = `${detail} detail · ${where}`;
}
updateSummary();
form.addEventListener("change", () => {
  updateSummary();
  try {
    localStorage.setItem("settings", JSON.stringify(values()));
  } catch {}
});
$("open-settings").onclick = $("summary").onclick = () => show("settings");
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

// Viewers. The camera starts at the first frame's pose when the pipeline wrote view.json; the
// viewer's automatic turntable starts paused.
async function makeViewer(container: HTMLElement, ply: string, viewDir: string, ui: boolean) {
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

// Progress: one row per pipeline stage, filled in as events arrive.
const PENDING = ["Preparing images", "Finding camera positions", "Training the splat"];
const row = (n: number) => $("stages").querySelector<HTMLElement>(`li[data-n="${n}"]`);
function renderStages() {
  $("stages").replaceChildren(
    ...PENDING.map((name, i) => {
      const li = document.createElement("li");
      li.dataset.n = String(i + 1);
      li.className = "row";
      li.dataset.state = "pending";
      li.innerHTML = `<span class="status"></span><div class="row-text"><div class="title"></div><div class="subtitle"></div><progress hidden></progress></div>`;
      li.querySelector(".title")!.textContent = name;
      return li;
    }),
  );
}
function addDetail(li: HTMLElement | null, text: string) {
  li?.querySelector(".subtitle")!.append(Object.assign(document.createElement("div"), { textContent: text }));
}

let projectDir = "";
let latestPreview = "";
let explorer: Viewer | null = null;

async function begin(path: string) {
  $("error").hidden = true;
  if (path.toLowerCase().endsWith(".ply")) {
    await invoke("allow_folder", { path });
    return openViewer(path, dirOf(path));
  }
  projectDir = latestPreview = "";
  renderStages();
  $("project-name").textContent = baseName(path);
  $<HTMLCanvasElement>("preview-canvas").getContext("2d")!.clearRect(0, 0, 800, 450);
  $("preview-empty").hidden = false;
  $("explore").hidden = true;
  $<HTMLButtonElement>("stop").disabled = false;
  $("stop").textContent = "Stop";
  show("progress");
  if (!(await isPermissionGranted().catch(() => true))) requestPermission().catch(() => {});
  invoke("start", { request: request(path) }).catch((err) => fail(String(err)));
}

// Pipeline errors end with "\nDetails: <log path>"; the path goes behind the Show log button.
let errorLog = "";
function fail(message: string) {
  closeExplorer();
  const [text, logPath = ""] = message.split("\nDetails: ");
  errorLog = logPath.trim();
  $("error-text").textContent = text;
  $("error-log").hidden = !errorLog;
  $("error").hidden = false;
  show("home");
}
$("error-close").onclick = () => ($("error").hidden = true);
$("error-log").onclick = () => revealItemInDir(errorLog);

listen<JobEvent>("job", ({ payload: e }) => {
  switch (e.kind) {
    case "project":
      projectDir = e.path;
      break;
    case "stage": {
      const li = row(e.n);
      if (!li) break;
      // "Training the splat (Brush)" -> name plus a small tool tag
      const [, label, tool] = e.name.match(/^(.*?)(?: \((.+)\))?$/)!;
      const name = li.querySelector(".title")!;
      name.textContent = label;
      if (tool) name.append(Object.assign(document.createElement("span"), { className: "tool", textContent: tool }));
      li.dataset.state = e.skipped ? "done" : "running";
      if (e.skipped) addDetail(li, "Already done");
      break;
    }
    case "stageDone": {
      const li = row(e.n);
      if (li) {
        li.dataset.state = "done";
        const bar = li.querySelector("progress")!;
        if (!bar.hidden) li.querySelector(".subtitle")!.textContent = "";
        bar.hidden = true;
        addDetail(li, `Took ${e.secs < 90 ? `${e.secs} s` : `${Math.round(e.secs / 60)} min`}`);
      }
      break;
    }
    case "info":
      addDetail($("stages").querySelector<HTMLElement>('li[data-state="running"]'), e.text);
      break;
    case "steps": {
      const li = $("stages").querySelector<HTMLElement>('li[data-state="running"]');
      if (!li) break;
      const bar = li.querySelector("progress")!;
      Object.assign(bar, { hidden: false, max: e.total, value: e.iter });
      li.querySelector(".subtitle")!.textContent = `${e.iter.toLocaleString()} of ${e.total.toLocaleString()} steps`;
      break;
    }
    case "preview":
      latestPreview = e.path;
      $("explore").hidden = false;
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
      $("preview-empty").hidden = true;
    } catch (err) {
      console.error("preview failed", err);
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
