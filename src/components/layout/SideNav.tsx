import { Component, createSignal } from "solid-js";
import "./SideNav.css";

interface SideNavProps {
  onNavigate: (section: string) => void;
  activeSection?: string;
}

const SideNav: Component<SideNavProps> = (props) => {
  const [isExpanded, setIsExpanded] = createSignal(false);

  const navItems = [
    { id: "chat", icon: "chat", label: "Chat" },
    { id: "files", icon: "folder_open", label: "Files" },
    { id: "skills", icon: "bolt", label: "Skills" },
    { id: "settings", icon: "settings", label: "Settings" },
  ];

  const bottomItems = [
    { id: "help", icon: "help", label: "Help" },
  ];

  return (
    <nav
      class={`sidenav ${isExpanded() ? "expanded" : ""}`}
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      <div class="sidenav-top">
        {navItems.map((item) => (
          <a
            class={`nav-item ${props.activeSection === item.id ? "active" : ""}`}
            onClick={() => props.onNavigate(item.id)}
          >
            <span class="material-symbols-outlined nav-icon" classList={{ filled: props.activeSection === item.id }}>
              {item.icon}
            </span>
            <span class="nav-label">{item.label}</span>
          </a>
        ))}
      </div>

      <div class="sidenav-bottom">
        {bottomItems.map((item) => (
          <a class="nav-item" onClick={() => props.onNavigate(item.id)}>
            <span class="material-symbols-outlined nav-icon">{item.icon}</span>
            <span class="nav-label">{item.label}</span>
          </a>
        ))}

        <div class="user-profile">
          <div class="avatar">
            <span class="material-symbols-outlined">person</span>
          </div>
          <div class="user-info">
            <span class="user-name">律师</span>
            <span class="user-role">高级合伙人</span>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default SideNav;
