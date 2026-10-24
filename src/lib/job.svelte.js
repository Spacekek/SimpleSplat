// The running job, filled in from the pipeline's events (pipeline::Event).
import { baseName } from "./paths.js";
import { invoke, listen } from "./tauri.js";

const STAGES = ["Preparing images", "Finding camera positions", "Training the splat"];

export const job = $state({
  name: "",
  projectDir: "",
  latestPreview: "",
  /** The expected finish, in milliseconds since 1970, or 0. */
  finishAt: 0,
  /** Messages from before the first stage (the GPU memory check). */
  notes: "",
  stopping: false,
  stages: [],
});

/** Starts making a splat of `path` with `request`'s settings; rejects with the reason it couldn't. */
export function startJob(path, request) {
  Object.assign(job, {
    name: baseName(path),
    projectDir: "",
    latestPreview: "",
    finishAt: 0,
    notes: "",
    stopping: false,
    stages: STAGES.map((name) => ({ name, state: "pending", fraction: 0, what: "", details: [] })),
  });
  return invoke("start", { request });
}

export function stopJob() {
  job.stopping = true;
  invoke("stop");
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;

listen("job", ({ payload: e }) => {
  const stage = job.stages[e.stage];
  switch (e.kind) {
    case "project":
      job.projectDir = e.path;
      break;
    case "stageStart":
      stage.name = e.name;
      stage.state = e.skipped ? "done" : "running";
      if (e.skipped) {
        stage.fraction = 1;
        stage.details.push("Already done");
      }
      break;
    case "stageDone":
      Object.assign(stage, { state: "done", fraction: 1, what: "" });
      stage.details.push(`Took ${e.secs < 90 ? plural(e.secs, "second") : plural(Math.round(e.secs / 60), "minute")}`);
      break;
    case "info": {
      const running = job.stages.find((s) => s.state === "running");
      if (running) running.details.push(e.text);
      else job.notes = e.text;
      break;
    }
    case "progress":
      Object.assign(stage, { fraction: e.fraction, what: e.what });
      job.finishAt = Date.now() + e.eta * 1000;
      break;
    case "preview":
      job.latestPreview = e.path;
      break;
  }
});
