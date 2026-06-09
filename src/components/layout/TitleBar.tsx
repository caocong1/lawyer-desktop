import { Component } from "solid-js";
import "./TitleBar.css";

const TitleBar: Component = () => {
  return (
    <header class="titlebar drag-region">
      <div class="titlebar-left no-drag">
        <div class="traffic-lights">
          <span class="traffic-light traffic-light-close"></span>
          <span class="traffic-light traffic-light-minimize"></span>
          <span class="traffic-light traffic-light-maximize"></span>
        </div>
        <span class="app-title">Lexis-Forge AI</span>
      </div>
      <div class="titlebar-right no-drag">
        <span class="session-label">Active Session: Contract_Analysis_v2</span>
        <div class="window-controls">
          <button class="window-btn" title="最小化">
            <span class="material-symbols-outlined">remove</span>
          </button>
          <button class="window-btn" title="最大化">
            <span class="material-symbols-outlined">add</span>
          </button>
          <button class="window-btn" title="关闭">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>
    </header>
  );
};

export default TitleBar;
