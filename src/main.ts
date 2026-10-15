import { invoke } from "@tauri-apps/api/core";

const list = document.querySelector("#tools")!;
invoke<string[]>("tool_versions").then((lines) =>
  list.replaceChildren(...lines.map((line) => Object.assign(document.createElement("li"), { textContent: line }))),
);
