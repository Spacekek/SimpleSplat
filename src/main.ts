import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { createViewer } from "@playcanvas/supersplat-viewer/viewer";
import { defaultSettings } from "@playcanvas/supersplat-viewer/settings";
import "@playcanvas/supersplat-viewer/viewer.css";

/** Mirrors pipeline::Event. */
type JobEvent =
  | { kind: "project"; path: string }
  | { kind: "stage"; n: number; name: string; skipped: boolean }
  | { kind: "stageDone"; n: number; secs: number }
  | { kind: "info"; text: string }
  | { kind: "progress"; n: number; fraction: number; overall: number; eta: number; what: string }
  | { kind: "preview"; path: string };
type Viewer = Awaited<ReturnType<typeof createViewer>>;
type View = "home" | "progress" | "viewer";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (view: View) => (document.body.dataset.view = view);
const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
const baseName = (path: string) => path.replace(/^.*[\\/]/, "");
const dialog = (id: string) => $<HTMLDialogElement>(id);
// Focus the dialog itself, as libadwaita does, rather than its first button (the close button).
const openDialog = (id: string) => {
  dialog(id).showModal();
  dialog(id).focus();
};
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

// The header bars double as the title bar (tauri.macos/linux.conf.json). macOS keeps its own
// window buttons over them; Linux has none, so add GNOME's close button to each bar.
const platform = /Mac/.test(navigator.userAgent) ? "mac" : /Linux/.test(navigator.userAgent) ? "linux" : "other";
document.body.dataset.platform = platform;
if (platform === "linux") {
  for (const end of document.querySelectorAll("body > section .headerbar .end, body > section .osd-bar .end")) {
    const close = document.createElement("button");
    close.className = `btn circular window-close ${end.closest(".osd-bar") ? "osd" : ""}`;
    close.title = "Close";
    close.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    close.onclick = () => getCurrentWindow().close();
    end.append(close);
  }
}

// Settings: the form is the source of truth, remembered between launches. Detail's radios sit on the
// home screen, tied to the form by their form attribute.
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

// Each Detail level's settings (pipeline::Settings, Low to High): what Auto and empty fields take.
type Preset = Record<string, string | number | boolean | null>;
const LEVELS = ["low", "medium", "high"];
let presets: Preset[] = [];
const level = () => Math.max(0, LEVELS.indexOf(String(values().detail)));
const cap = (text: string) => text.replace(/^./, (c) => c.toUpperCase());
const grouped = (n: number) => n.toLocaleString("en-US");
const NOT_ADVANCED = ["detail", "output", "outDir"];
// A preset's value of a setting, and how it reads.
const raw = (name: string, p: Preset) => (name === "exportEvery" ? (p.exportEvery ?? Number(p.steps) / 5) : p[name]);
function shown(name: string, value: Preset[string]): string {
  if (name === "singleCamera" && value === null) return "Yes for video, no for photos";
  if (name === "maxSplats") return `${Number(value) / 1e6} million`;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return grouped(value) + (name === "maxSize" ? " px" : "");
  return cap(String(value));
}
function renderDefaults() {
  const current = level();
  $("current-detail").textContent = cap(LEVELS[current]);
  if (!presets.length) return;
  for (const el of document.querySelectorAll<HTMLElement>("[data-for]")) {
    const name = el.dataset.for!;
    const all = presets.map((p) => shown(name, raw(name, p)));
    el.replaceChildren();
    const input = form.elements.namedItem(name);
    const value = raw(name, presets[current]);
    // The same at every level: a field's placeholder or an Auto option already says it; a switch can't.
    const same = all.every((v) => v === all[0]);
    el.hidden = same && !(input instanceof HTMLInputElement && input.type === "checkbox");
    if (same) el.append(`Default: ${all[0]}`);
    else if (all.every((v, i) => v === cap(LEVELS[i]))) el.append("Default: the same as Detail");
    else {
      el.append("Default: ");
      all.forEach((v, i) => {
        if (i) el.append(" · ");
        el.append(Object.assign(document.createElement(i === current ? "strong" : "span"), { textContent: `${cap(LEVELS[i])} ${v}` }));
      });
    }
    if (input instanceof HTMLInputElement && input.type === "number") input.placeholder = grouped(Number(value));
    // Single Camera's Auto depends on the input, not on Detail, so its text stays short.
    if (input instanceof HTMLSelectElement) input.options[0].text = value === null ? "Auto" : `Auto (${shown(name, value)})`;
  }
}
// Advanced settings changed from their default.
function customCount() {
  const p = presets[level()];
  return fields().filter((el) => !NOT_ADVANCED.includes(el.name) && (el.type === "checkbox" ? p && el.checked !== p[el.name] : el.value !== "")).length;
}

// What a run with these settings needs of the GPU's memory (the backend asks Spirula for the GPU once).
type Fit = { gpu?: { name: string; mib: number }; need: string; warning?: string };
let fit: Fit | null = null;
async function updateFit() {
  try {
    fit = await invoke<Fit>("estimate", { request: request("") });
    updateHome();
  } catch {}
}

// The home screen shows only what needs attention: a GPU memory warning, and what differs from the defaults.
function updateHome() {
  const v = values();
  const warning = !fit ? "" : (fit.warning ?? (fit.gpu ? "" : "No supported GPU found. SimpleSplat needs Vulkan, or Metal on macOS."));
  Object.assign($("gpu-warning"), { textContent: warning, hidden: !warning });
  // Settings shows the estimate either way.
  $("gpu-fit").textContent = warning || (fit?.gpu ? `About ${fit.need} of the ${(fit.gpu.mib / 1024).toFixed(1)} GB GPU memory on ${fit.gpu.name}.` : "");
  $("gpu-fit").classList.toggle("warn", !!warning);
  $("gpu-fit").classList.toggle("dim", !warning);
  // The Settings button also says what differs from the defaults: custom settings, a chosen output folder.
  const n = customCount();
  $("settings-label").textContent = ["Settings", n ? `${n} custom` : "", v.output === "folder" && v.outDir ? `saved in ${baseName(String(v.outDir))}` : ""].filter(Boolean).join(" · ");
}

function onSettingsChange() {
  renderDefaults();
  updateHome();
  updateFit();
  try {
    localStorage.setItem("settings", JSON.stringify(values()));
  } catch {}
}
// Detail's radios are outside the form, so listen on the document.
document.addEventListener("change", (e) => {
  if ((e.target as HTMLInputElement).form === form) onSettingsChange();
});
invoke<Preset[]>("defaults")
  .then((p) => {
    presets = p;
    renderDefaults();
    updateHome();
  })
  .catch(() => {});
renderDefaults();
updateHome();
updateFit();

const openSettings = () => openDialog("settings");
$("open-settings").onclick = openSettings;
$("close-settings").onclick = () => dialog("settings").close();
// Enter in a field must not submit (and reload) the page.
form.addEventListener("submit", (e) => e.preventDefault());

// Spin rows: fewer and more step from the value, or from the default when the field is empty.
form.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-step]");
  if (!button) return;
  e.preventDefault();
  const input = button.parentElement!.querySelector("input")!;
  const from = Number(input.value || input.placeholder.replace(/,/g, ""));
  input.value = String(Math.max(Number(input.min), from + Number(button.dataset.step) * Number(input.dataset.step)));
  onSettingsChange();
});

// The main menu: Settings and About.
const menu = $("menu");
const setMenu = (open: boolean) => {
  menu.hidden = !open;
  $("menu-button").setAttribute("aria-expanded", String(open));
};
$("menu-button").onclick = (e) => {
  e.stopPropagation();
  setMenu(menu.hidden !== false); // hidden can also be "until-found"
};
document.addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => e.key === "Escape" && setMenu(false));
$("menu-settings").onclick = openSettings;
$("menu-about").onclick = () => openDialog("about");
$("close-about").onclick = () => dialog("about").close();
getVersion()
  .then((v) => ($("about-version").textContent = v))
  .catch(() => {});
if (__REPO__) {
  $("about-website").hidden = false;
  $("about-website").onclick = () => openUrl(`https://github.com/${__REPO__}`);
}
$("choose-out").onclick = async () => {
  const dir = await open({ directory: true });
  if (typeof dir !== "string") return;
  (form.elements.namedItem("outDir") as HTMLInputElement).value = dir;
  (form.elements.namedItem("output") as RadioNodeList).value = "folder";
  onSettingsChange();
};
$("reset").onclick = () => {
  const p = presets[level()];
  for (const el of fields()) {
    if (NOT_ADVANCED.includes(el.name)) continue;
    if (el.type === "checkbox") el.checked = Boolean(p?.[el.name] ?? true);
    else el.value = "";
  }
  onSettingsChange();
};

function request(input: string) {
  const v = values();
  const num = (k: string) => (v[k] ? Number(v[k]) : undefined);
  return {
    input,
    detail: v.detail,
    outDir: v.output === "folder" && v.outDir ? v.outDir : undefined,
    frames: num("frames"),
    fps: num("fps"),
    steps: num("steps"),
    maxSize: num("maxSize"),
    exportEvery: num("exportEvery"),
    singleCamera: v.singleCamera === "" ? undefined : v.singleCamera === "true",
    sfmQuality: v.sfmQuality || undefined,
    maxSplats: num("maxSplats"),
    floaterSuppression: v.floaterSuppression || undefined,
    ignoreMoving: v.ignoreMoving || undefined,
    exposureCorrection: v.exposureCorrection,
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

// A viewer that finishes loading after it was closed or replaced (generation moved on) is discarded.
let mainViewer: Viewer | null = null;
let viewerGen = 0;
let scenePath = "";
function closeViewer() {
  viewerGen++;
  mainViewer?.destroy();
  mainViewer = null;
}
async function openViewer(ply: string, viewDir: string) {
  closeViewer();
  const gen = viewerGen;
  scenePath = ply;
  show("viewer");
  const viewer = await makeViewer($("viewer-host"), ply, viewDir, true);
  if (gen === viewerGen) mainViewer = viewer;
  else viewer.destroy();
}
$("reveal").onclick = () => revealItemInDir(scenePath);
$("new").onclick = () => {
  closeViewer();
  show("home");
};

// Progress: one step per pipeline stage, side by side, filled in as events arrive.
const STAGES = ["Preparing images", "Finding camera positions", "Training the splat"];
const row = (n: number) => $("stages").querySelector<HTMLElement>(`li[data-n="${n}"]`);
function renderStages() {
  $("stages").replaceChildren(
    ...STAGES.map((name, i) => {
      const li = document.createElement("li");
      li.dataset.n = String(i + 1);
      li.className = "step";
      li.dataset.state = "pending";
      li.innerHTML = `<div class="step-head"><span class="status"></span><span class="label">${name}</span></div><progress max="1" value="0"></progress><div class="caption what"></div><div class="caption details"></div>`;
      return li;
    }),
  );
}
function addDetail(li: HTMLElement | null, text: string) {
  li?.querySelector(".details")!.append(Object.assign(document.createElement("div"), { textContent: text }));
}
const setBar = (li: HTMLElement, fraction: number) => (li.querySelector("progress")!.value = fraction);

let projectDir = "";
let latestPreview = "";
let explorer: Viewer | null = null;

async function begin(path: string) {
  dialog("error").close();
  if (path.toLowerCase().endsWith(".ply")) {
    await invoke("allow_folder", { path });
    return openViewer(path, dirOf(path));
  }
  closeViewer(); // a live viewer would slow training down
  // Nothing else checks the advanced fields' limits: the form is never submitted.
  if (!form.checkValidity()) {
    openSettings();
    form.reportValidity();
    return;
  }
  projectDir = latestPreview = "";
  finishAt = 0;
  showTimeLeft();
  renderStages();
  Object.assign($("notes"), { textContent: "", hidden: true });
  $("project-name").textContent = baseName(path);
  $<HTMLCanvasElement>("preview-canvas").getContext("2d")!.clearRect(0, 0, 800, 450);
  $("preview-empty").hidden = false;
  $("explore").hidden = true;
  $<HTMLButtonElement>("stop").disabled = false;
  $("stop-label").textContent = "Stop";
  show("progress");
  invoke("start", { request: request(path) }).catch((err) => fail(String(err)));
}

// The expected finish, as a time of day.
let finishAt = 0;
function showTimeLeft() {
  const secs = (finishAt - Date.now()) / 1000;
  const at = new Date(finishAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("time-left").textContent = !finishAt ? "" : secs < 60 ? " · almost ready" : ` · ready around ${at}`;
}
setInterval(showTimeLeft, 1000);

// Pipeline errors end with "\nDetails: <log path>"; the path goes behind the Show log button.
let errorLog = "";
function fail(message: string) {
  closeExplorer();
  const [text, logPath = ""] = message.split("\nDetails: ");
  errorLog = logPath.trim();
  $("error-text").textContent = text;
  $("error-log").hidden = !errorLog;
  dialog("error").showModal();
  show("home");
}
$("error-close").onclick = () => dialog("error").close();

// Update notice: a release build compares its version with the repository's latest release.
const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  const i = x.findIndex((part, i) => part !== (y[i] ?? 0));
  return i >= 0 && x[i] > (y[i] ?? 0);
};
if (__REPO__) {
  Promise.all([getVersion(), fetch(`https://api.github.com/repos/${__REPO__}/releases/latest`).then((r) => r.json())])
    .then(([version, release]) => {
      const latest = String(release.tag_name).replace(/^v/, "");
      if (!newer(latest, version)) return;
      $("update-text").textContent = `Version ${latest} is available (you have ${version})`;
      $("update-get").onclick = () => openUrl(release.html_url);
      $("update").hidden = false;
    })
    .catch(() => {}); // offline, or no releases yet
}
$("error-log").onclick = () => revealItemInDir(errorLog);

listen<JobEvent>("job", ({ payload: e }) => {
  switch (e.kind) {
    case "project":
      projectDir = e.path;
      break;
    case "stage": {
      const li = row(e.n);
      if (!li) break;
      li.querySelector(".label")!.textContent = e.name;
      li.dataset.state = e.skipped ? "done" : "running";
      if (e.skipped) {
        setBar(li, 1);
        addDetail(li, "Already done");
      }
      break;
    }
    case "stageDone": {
      const li = row(e.n);
      if (li) {
        li.dataset.state = "done";
        setBar(li, 1);
        li.querySelector(".what")!.textContent = "";
        addDetail(li, `Took ${e.secs < 90 ? plural(e.secs, "second") : plural(Math.round(e.secs / 60), "minute")}`);
      }
      break;
    }
    case "info": {
      // Messages before the first stage (the GPU memory check) go above the steps.
      const running = $("stages").querySelector<HTMLElement>('li[data-state="running"]');
      if (running) addDetail(running, e.text);
      else Object.assign($("notes"), { textContent: e.text, hidden: false });
      break;
    }
    case "progress": {
      const li = row(e.n);
      if (!li) break;
      setBar(li, e.fraction);
      li.querySelector(".what")!.textContent = e.what;
      finishAt = Date.now() + e.eta * 1000;
      showTimeLeft();
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
  finishAt = 0;
  if ("Ok" in payload) openViewer(payload.Ok, dirOf(payload.Ok));
  else if (payload.Err === "Stopped.") show("home");
  else fail(payload.Err);
});

$("stop").onclick = () => {
  $<HTMLButtonElement>("stop").disabled = true;
  $("stop-label").textContent = "Stopping…";
  invoke("stop");
};

// A live viewer keeps rendering and slowed training by 16% in the spike, so previews are stills:
// load the export off-screen, capture one frame, and tear the viewer down again.
let capturing: Promise<void> = Promise.resolve();
function capturePreview(ply: string) {
  capturing = capturing.then(async () => {
    if (ply !== latestPreview) return; // a newer export arrived while we waited
    // Everything inside the try: a rejection would skip every later capture in the chain.
    let viewer: Viewer | undefined;
    try {
      viewer = await makeViewer($("capture-host"), ply, projectDir, false);
      const { width, height, data } = await viewer.captureFrame({ width: 800, height: 450 });
      const pixels = Uint8ClampedArray.from(atob(data), (c) => c.charCodeAt(0));
      $<HTMLCanvasElement>("preview-canvas").getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
      $("preview-empty").hidden = true;
    } catch (err) {
      console.error("preview failed", err);
    } finally {
      viewer?.destroy();
    }
  });
}

// Like the main viewer: one that loads after Close (or the job's end) is discarded.
let exploreGen = 0;
$("explore").onclick = async () => {
  if (!$("explore-note").hidden) return closeExplorer(); // open, or still loading
  $("explore").textContent = "Close";
  $("explore-note").hidden = false;
  const gen = exploreGen;
  const viewer = await makeViewer($("explore-host"), latestPreview, projectDir, true);
  if (gen === exploreGen) explorer = viewer;
  else viewer.destroy();
};
function closeExplorer() {
  exploreGen++;
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
