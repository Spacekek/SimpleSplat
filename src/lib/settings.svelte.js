// The run's settings: the Settings form, remembered between launches, over the Detail presets from
// the backend (pipeline::Settings). An empty field means the Detail's default.
import { invoke } from "./tauri.js";

export const DETAILS = ["low", "medium", "high"];

// The advanced settings as they start: fields empty, switches on.
const ADVANCED = {
  frames: "",
  fps: "",
  maxSize: "",
  singleCamera: "",
  sfmQuality: "",
  steps: "",
  maxSplats: "",
  floaterSuppression: "",
  ignoreMoving: "",
  exposureCorrection: true,
  exportEvery: "",
  keepIntermediates: true,
};
const START = { detail: "medium", output: "next", outDir: "", ...ADVANCED };

function saved() {
  try {
    const values = JSON.parse(localStorage.getItem("settings") ?? "{}");
    return Object.fromEntries(Object.entries(values).filter(([name]) => name in START));
  } catch {
    return {};
  }
}

export const settings = $state({
  values: { ...START, ...saved() },
  /** Each Detail's settings, Low to High: what Auto and empty fields take. */
  presets: [],
  /** What a run with these settings needs of the GPU's memory: { gpu?: { name, mib }, need, warning? }. */
  fit: null,
});

invoke("defaults")
  .then((presets) => {
    settings.presets = presets;
  })
  .catch(() => {});

$effect.root(() => {
  $effect(() => {
    const json = JSON.stringify(settings.values);
    try {
      localStorage.setItem("settings", json);
    } catch {}
  });
  // The backend asks Spirula for the GPU once, then only estimates.
  $effect(() => {
    if (!settings.presets.length) return;
    invoke("estimate", { request: request("") })
      .then((fit) => {
        settings.fit = fit;
      })
      .catch(() => {});
  });
});

const isEmpty = (value) => value === "" || value == null;
export const detailIndex = () => Math.max(0, DETAILS.indexOf(settings.values.detail));
export const cap = (text) => text.replace(/^./, (c) => c.toUpperCase());
export const grouped = (n) => n.toLocaleString("en-US");

/** A preset's value of a setting; Preview Every's follows its steps. */
export const presetValue = (name, preset) => (name === "exportEvery" ? (preset.exportEvery ?? preset.steps / 5) : preset[name]);

/** How a setting's value reads. */
export function describe(name, value) {
  if (name === "singleCamera" && value === null) return "Yes for video, no for photos";
  if (name === "maxSplats") return `${Number(value) / 1e6} million`;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return grouped(value) + (name === "maxSize" ? " px" : "");
  return cap(String(value));
}

/** How many advanced settings differ from their default. */
export function customCount() {
  const preset = settings.presets[detailIndex()];
  return Object.entries(ADVANCED).filter(([name, start]) => {
    const value = settings.values[name];
    return typeof start === "boolean" ? preset && value !== preset[name] : !isEmpty(value);
  }).length;
}

export function resetAdvanced() {
  const preset = settings.presets[detailIndex()];
  for (const [name, start] of Object.entries(ADVANCED)) {
    settings.values[name] = typeof start === "boolean" ? Boolean(preset?.[name] ?? true) : "";
  }
}

/** The Detail's settings with the advanced ones changed from it (pipeline::Settings). */
export function request(input) {
  const v = settings.values;
  const num = (name) => (isEmpty(v[name]) ? undefined : Number(v[name]));
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
    ...settings.presets[detailIndex()],
    ...Object.fromEntries(Object.entries(changed).filter(([, value]) => value !== undefined)),
    input,
    outDir: v.output === "folder" && v.outDir ? v.outDir : undefined,
  };
}

/** A warning when a run may not fit in the GPU's memory, or there is no GPU at all. */
export function gpuWarning() {
  const fit = settings.fit;
  if (!fit) return "";
  return fit.warning ?? (fit.gpu ? "" : "No supported GPU found. SimpleSplat needs Vulkan, or Metal on macOS.");
}

/** The warning, or else the estimate. */
export function gpuFit() {
  const fit = settings.fit;
  return gpuWarning() || (fit?.gpu ? `About ${fit.need} of the ${(fit.gpu.mib / 1024).toFixed(1)} GB GPU memory on ${fit.gpu.name}.` : "");
}
