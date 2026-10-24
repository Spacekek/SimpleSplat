import "@playcanvas/supersplat-viewer/viewer.css";
import "./adwaita.css";
import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";

// The stylesheets expect the views directly in <body>.
mount(App, { target: document.body });
