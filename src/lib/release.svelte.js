// The app's version and, in CI builds, the GitHub repository ("owner/name") and a newer release
// there. Local builds don't know their repository, so they never look.
import { getVersion, invoke } from "./tauri.js";

export const release = $state({ version: "", repo: "", update: null });

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  const i = x.findIndex((part, i) => part !== (y[i] ?? 0));
  return i >= 0 && x[i] > (y[i] ?? 0);
};

getVersion()
  .then((version) => (release.version = version))
  .catch(() => {});

invoke("repo")
  .catch(() => "")
  .then((repo) => {
    release.repo = repo;
    if (!repo) return;
    Promise.all([getVersion(), fetch(`https://api.github.com/repos/${repo}/releases/latest`).then((r) => r.json())])
      .then(([version, latest]) => {
        const tag = String(latest.tag_name).replace(/^v/, "");
        if (newer(tag, version)) release.update = { version: tag, url: latest.html_url };
      })
      .catch(() => {}); // offline, or no releases yet
  });
