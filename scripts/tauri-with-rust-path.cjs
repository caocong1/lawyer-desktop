/**
 * Ensure rustup's MSVC toolchain wins over Chocolatey GNU rust on Windows.
 * Project target: x86_64-pc-windows-msvc (see src-tauri/.cargo/config.toml)
 */
const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");
const { freePort, DEFAULT_PORT } = require("./free-port.cjs");

function preferRustupPath() {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  const sep = path.delimiter;
  const parts = (process.env.PATH || "").split(sep).filter(Boolean);

  const rest = parts.filter((p) => {
    const norm = p.toLowerCase().replace(/\//g, "\\");
    return norm !== cargoBin.toLowerCase().replace(/\//g, "\\");
  });

  return [cargoBin, ...rest].join(sep);
}

const root = path.join(__dirname, "..");
const env = { ...process.env, PATH: preferRustupPath() };
const args = process.argv.slice(2);

if (args[0] === "dev") {
  freePort(DEFAULT_PORT);
}

const result = spawnSync("bunx", ["tauri", ...args], {
  stdio: "inherit",
  env,
  cwd: root,
  shell: true,
});

process.exit(result.status ?? 1);
