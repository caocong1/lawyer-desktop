import { Component } from "solid-js";
import "./StatusBar.css";

const StatusBar: Component = () => {
  return (
    <footer class="statusbar">
      <div class="statusbar-left">
        <span class="status-label">System Connected | Lexis-Forge v2.1</span>
        <div class="status-indicator">
          <span class="status-dot"></span>
          <span class="status-text">Legal Engine Online</span>
        </div>
      </div>
      <div class="statusbar-right">
        <a class="status-link" href="#">API Status</a>
        <a class="status-link" href="#">Terms</a>
        <span class="status-info">UTF-8 | Mainland China Laws</span>
      </div>
    </footer>
  );
};

export default StatusBar;
