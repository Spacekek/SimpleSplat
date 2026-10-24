import { createViewer } from "./vendor/supersplat-viewer/dist/viewer.js";
import { defaultSettings } from "./vendor/supersplat-viewer/dist/settings.js";

// Tauri's JavaScript API, which the app itself provides (withGlobalTauri in tauri.conf.json).
const { getVersion } = window.__TAURI__.app;
const { convertFileSrc, invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWebview } = window.__TAURI__.webview;
const { getCurrentWindow } = window.__TAURI__.window;
const { open } = window.__TAURI__.dialog;
const { openUrl, revealItemInDir } = window.__TAURI__.opener;

const $ = (id) => document.getElementById(id);
const show = (view) => (document.body.dataset.view = view); // "home", "progress" or "viewer"
const dirOf = (path) => path.replace(/[\\/][^\\/]*$/, "");
const baseName = (path) => path.replace(/^.*[\\/]/, "");
const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
// Focus the dialog itself, as libadwaita does, rather than its first button (the close button).
const openDialog = (id) => {
  $(id).showModal();
  $(id).focus();
};

// ---- Window

// The header bars double as the title bar (tauri.macos/linux.conf.json). macOS keeps its own
// window buttons over them; Linux has none, so add GNOME's close button to each bar.
const platform = /Mac/.test(navigator.userAgent) ? "mac" : /Linux/.test(navigator.userAgent) ? "linux" : "other";
document.body.dataset.platform = platform;
if (platform === "linux") {
  for (const end of document.querySelectorAll("body > section .headerbar .end, body > section .osd-bar .end")) {
    const close = document.createElement("button");
    close.className = `btn circular window-close ${end.closest(".osd-bar") ? "osd" : ""}`;
    close.title = "Close";
    close.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><use href="#icon-close" /></svg>`;
    close.onclick = () => getCurrentWindow().close();
    end.append(close);
  }
}

// ---- Settings

// The form is the source of truth, remembered between launches. Detail's radios sit on the home
// screen, tied to the form by their form attribute.
const form = $("settings-form");
const fields = () => [...form.elements].filter((el) => "name" in el && !!el.name);
try {
  const saved = JSON.parse(localStorage.getItem("settings") ?? "{}");
  for (const el of fields()) {
    if (!(el.name in saved)) continue;
    if (el.type === "checkbox") el.checked = saved[el.name];
    else if (el.type === "radio") el.checked = el.value === saved[el.name];
    else el.value = saved[el.name];
  }
} catch {}
function values() {
  const v = {};
  for (const el of fields()) {
    if (el.type === "checkbox") v[el.name] = el.checked;
    else if (el.type !== "radio" || el.checked) v[el.name] = el.value;
  }
  return v;
}

// Each Detail's settings (pipeline::Settings), Low to High: what Auto and empty fields take.
const DETAILS = ["low", "medium", "high"];
let presets = [];
const detailIndex = () => Math.max(0, DETAILS.indexOf(String(values().detail)));
const BASIC_FIELDS = ["detail", "output", "outDir"];
const cap = (text) => text.replace(/^./, (c) => c.toUpperCase());
const grouped = (n) => n.toLocaleString("en-US");
const presetValue = (name, preset) => (name === "exportEvery" ? (preset.exportEvery ?? Number(preset.steps) / 5) : preset[name]);
function describe(name, value) {
  if (name === "singleCamera" && value === null) return "Yes for video, no for photos";
  if (name === "maxSplats") return `${Number(value) / 1e6} million`;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return grouped(value) + (name === "maxSize" ? " px" : "");
  return cap(String(value));
}

// Under each advanced setting, its default at each Detail.
function renderDefaults() {
  const current = detailIndex();
  $("current-detail").textContent = cap(DETAILS[current]);
  if (!presets.length) return;
  for (const el of document.querySelectorAll("[data-for]")) {
    const name = el.dataset.for;
    const all = presets.map((preset) => describe(name, presetValue(name, preset)));
    el.replaceChildren();
    const input = form.elements.namedItem(name);
    const value = presetValue(name, presets[current]);
    // The same at every Detail: a field's placeholder or an Auto option already says it; a switch can't.
    const same = all.every((v) => v === all[0]);
    el.hidden = same && !(input instanceof HTMLInputElement && input.type === "checkbox");
    if (same) el.append(`Default: ${all[0]}`);
    else if (all.every((v, i) => v === cap(DETAILS[i]))) el.append("Default: the same as Detail");
    else {
      el.append("Default: ");
      all.forEach((v, i) => {
        if (i) el.append(" · ");
        el.append(Object.assign(document.createElement(i === current ? "strong" : "span"), { textContent: `${cap(DETAILS[i])} ${v}` }));
      });
    }
    if (input instanceof HTMLInputElement && input.type === "number") input.placeholder = grouped(Number(value));
    // Single Camera's Auto depends on the input, not on Detail, so its text stays short.
    if (input instanceof HTMLSelectElement) input.options[0].text = value === null ? "Auto" : `Auto (${describe(name, value)})`;
  }
}

function customCount() {
  const preset = presets[detailIndex()];
  const changed = (el) => (el.type === "checkbox" ? preset && el.checked !== preset[el.name] : el.value !== "");
  return fields().filter((el) => !BASIC_FIELDS.includes(el.name) && changed(el)).length;
}

// The Detail's settings with the advanced ones changed from it (pipeline::Settings).
function request(input) {
  const v = values();
  const num = (k) => (v[k] ? Number(v[k]) : undefined);
  const changed = {
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
  return {
    ...presets[detailIndex()],
    ...Object.fromEntries(Object.entries(changed).filter(([, value]) => value !== undefined)),
    input,
    outDir: v.output === "folder" && v.outDir ? v.outDir : undefined,
  };
}

// Number fields get − and + buttons. They step by the field's data-step, from its value or, when it
// is empty, from the default its placeholder shows.
for (const input of form.querySelectorAll(".spin input")) {
  for (const [direction, label, text] of [[-1, "Less", "−"], [1, "More", "+"]]) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "btn flat circular", textContent: text });
    button.setAttribute("aria-label", label);
    button.onclick = () => {
      const from = Number(input.value || input.placeholder.replace(/,/g, ""));
      input.value = String(Math.max(Number(input.min), from + direction * Number(input.dataset.step)));
      onSettingsChange();
    };
    input.parentElement.append(button);
  }
}

$("choose-out").onclick = async () => {
  const dir = await open({ directory: true });
  if (typeof dir !== "string") return;
  form.elements.namedItem("outDir").value = dir;
  form.elements.namedItem("output").value = "folder";
  onSettingsChange();
};
$("reset").onclick = () => {
  const preset = presets[detailIndex()];
  for (const el of fields()) {
    if (BASIC_FIELDS.includes(el.name)) continue;
    if (el.type === "checkbox") el.checked = Boolean(preset?.[el.name] ?? true);
    else el.value = "";
  }
  onSettingsChange();
};
// Enter in a field must not submit (and reload) the page.
form.addEventListener("submit", (e) => e.preventDefault());

// What a run with these settings needs of the GPU's memory (the backend asks Spirula for the GPU once):
// { gpu?: { name, mib }, need, warning? }.
let fit = null;
async function updateFit() {
  try {
    fit = await invoke("estimate", { request: request("") });
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
  if (e.target.form === form) onSettingsChange();
});

const openSettings = () => openDialog("settings");
$("open-settings").onclick = openSettings;
$("close-settings").onclick = () => $("settings").close();

invoke("defaults")
  .then((p) => {
    presets = p;
    renderDefaults();
    updateHome();
    updateFit(); // it sends a preset's settings
  })
  .catch(() => {});
renderDefaults();
updateHome();

// ---- Main menu, About and updates

const menu = $("menu");
const setMenu = (open) => {
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
$("close-about").onclick = () => $("about").close();
getVersion()
  .then((v) => ($("about-version").textContent = v))
  .catch(() => {});

// GitHub repository ("owner/name") of a CI build, else "": only CI builds link to it and look for
// newer releases there.
const repo = invoke("repo").catch(() => "");
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  const i = x.findIndex((part, i) => part !== (y[i] ?? 0));
  return i >= 0 && x[i] > (y[i] ?? 0);
};
repo.then((repo) => {
  if (!repo) return;
  $("about-website").hidden = false;
  $("about-website").onclick = () => openUrl(`https://github.com/${repo}`);
  Promise.all([getVersion(), fetch(`https://api.github.com/repos/${repo}/releases/latest`).then((r) => r.json())])
    .then(([version, release]) => {
      const latest = String(release.tag_name).replace(/^v/, "");
      if (!newer(latest, version)) return;
      $("update-text").textContent = `Version ${latest} is available (you have ${version})`;
      $("update-get").onclick = () => openUrl(release.html_url);
      $("update").hidden = false;
    })
    .catch(() => {}); // offline, or no releases yet
});

// ---- Viewers

// The camera starts at the first frame's pose when the pipeline wrote view.json; the viewer's
// automatic turntable starts paused.
async function makeViewer(container, ply, viewDir, ui) {
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

// A place for one viewer at a time. A viewer that finishes loading after the slot was closed, or
// opened again, is discarded.
function viewerSlot(host) {
  let viewer = null;
  let generation = 0;
  return {
    async open(ply, viewDir) {
      this.close();
      const current = generation;
      const loaded = await makeViewer(host, ply, viewDir, true);
      if (current === generation) viewer = loaded;
      else loaded.destroy();
    },
    close() {
      generation++;
      viewer?.destroy();
      viewer = null;
    },
  };
}

const mainViewer = viewerSlot($("viewer-host"));
let scenePath = "";
function openViewer(ply) {
  scenePath = ply;
  show("viewer");
  mainViewer.open(ply, dirOf(ply));
}
$("reveal").onclick = () => revealItemInDir(scenePath);
$("new").onclick = () => {
  mainViewer.close();
  show("home");
};

// ---- Progress

// One step per pipeline stage, side by side, filled in as events arrive.
const STAGES = ["Preparing images", "Finding camera positions", "Training the splat"];
const row = (stage) => $("stages").querySelector(`li[data-stage="${stage}"]`);
function renderStages() {
  $("stages").replaceChildren(
    ...STAGES.map((name, stage) => {
      const li = document.createElement("li");
      li.dataset.stage = String(stage);
      li.className = "step";
      li.dataset.state = "pending";
      li.innerHTML = `<div class="step-head"><span class="status"></span><span class="label">${name}</span></div><progress max="1" value="0"></progress><div class="caption what"></div><div class="caption details"></div>`;
      return li;
    }),
  );
}
function addDetail(li, text) {
  li?.querySelector(".details").append(Object.assign(document.createElement("div"), { textContent: text }));
}
const setBar = (li, fraction) => (li.querySelector("progress").value = fraction);

// The expected finish, as a time of day.
let finishAt = 0;
function showTimeLeft() {
  const secs = (finishAt - Date.now()) / 1000;
  const at = new Date(finishAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("time-left").textContent = !finishAt ? "" : secs < 60 ? " · almost ready" : ` · ready around ${at}`;
}
setInterval(showTimeLeft, 1000);

let projectDir = "";
let latestPreview = "";

// The pipeline's events (pipeline::Event), told apart by kind.
listen("job", ({ payload: e }) => {
  switch (e.kind) {
    case "project":
      projectDir = e.path;
      break;
    case "stageStart": {
      const li = row(e.stage);
      if (!li) break;
      li.querySelector(".label").textContent = e.name;
      li.dataset.state = e.skipped ? "done" : "running";
      if (e.skipped) {
        setBar(li, 1);
        addDetail(li, "Already done");
      }
      break;
    }
    case "stageDone": {
      const li = row(e.stage);
      if (!li) break;
      li.dataset.state = "done";
      setBar(li, 1);
      li.querySelector(".what").textContent = "";
      addDetail(li, `Took ${e.secs < 90 ? plural(e.secs, "second") : plural(Math.round(e.secs / 60), "minute")}`);
      break;
    }
    case "info": {
      // Messages before the first stage (the GPU memory check) go above the steps.
      const running = $("stages").querySelector('li[data-state="running"]');
      if (running) addDetail(running, e.text);
      else Object.assign($("notes"), { textContent: e.text, hidden: false });
      break;
    }
    case "progress": {
      const li = row(e.stage);
      if (!li) break;
      setBar(li, e.fraction);
      li.querySelector(".what").textContent = e.what;
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

// The job's result: { Ok: scene path } or { Err: message }.
listen("job-end", ({ payload }) => {
  closeExplorer();
  finishAt = 0;
  if ("Ok" in payload) openViewer(payload.Ok);
  else if (payload.Err === "Stopped.") show("home");
  else fail(payload.Err);
});

$("stop").onclick = () => {
  $("stop").disabled = true;
  $("stop-label").textContent = "Stopping…";
  invoke("stop");
};

// A live viewer keeps rendering and slowed training by 16% in the spike, so previews are stills:
// load the export off-screen, capture one frame, and tear the viewer down again.
const previewCanvas = $("preview-canvas");
let capturing = Promise.resolve();
function capturePreview(ply) {
  capturing = capturing.then(async () => {
    if (ply !== latestPreview) return; // a newer export arrived while we waited
    // Everything inside the try: a rejection would skip every later capture in the chain.
    let viewer;
    try {
      viewer = await makeViewer($("capture-host"), ply, projectDir, false);
      const { width, height, data } = await viewer.captureFrame({ width: previewCanvas.width, height: previewCanvas.height });
      const pixels = Uint8ClampedArray.from(atob(data), (c) => c.charCodeAt(0));
      previewCanvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
      $("preview-empty").hidden = true;
    } catch (err) {
      console.error("preview failed", err);
    } finally {
      viewer?.destroy();
    }
  });
}

// Explore: the latest preview in a live viewer, until Close or the job's end.
const explorer = viewerSlot($("explore-host"));
$("explore").onclick = () => {
  if (!$("explore-note").hidden) return closeExplorer(); // open, or still loading
  $("explore").textContent = "Close";
  $("explore-note").hidden = false;
  explorer.open(latestPreview, projectDir);
};
function closeExplorer() {
  explorer.close();
  $("explore-host").replaceChildren();
  $("explore").textContent = "Explore";
  $("explore-note").hidden = true;
}

// ---- Input: drag and drop onto the window, or the choose buttons

async function begin(path) {
  $("error").close();
  if (path.toLowerCase().endsWith(".ply")) {
    await invoke("allow_folder", { path });
    return openViewer(path);
  }
  mainViewer.close(); // a live viewer would slow training down
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
  previewCanvas.getContext("2d").clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  $("preview-empty").hidden = false;
  $("explore").hidden = true;
  $("stop").disabled = false;
  $("stop-label").textContent = "Stop";
  show("progress");
  invoke("start", { request: request(path) }).catch((err) => fail(String(err)));
}

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

// ---- Errors

// Pipeline errors end with "\nDetails: <log path>"; the path goes behind the Show Log button.
let errorLog = "";
function fail(message) {
  closeExplorer();
  const [text, logPath = ""] = message.split("\nDetails: ");
  errorLog = logPath.trim();
  $("error-text").textContent = text;
  $("error-log").hidden = !errorLog;
  $("error").showModal();
  show("home");
}
$("error-log").onclick = () => revealItemInDir(errorLog);
$("error-close").onclick = () => $("error").close();
