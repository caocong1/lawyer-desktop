const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

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

const env = { ...process.env, PATH: preferRustupPath() };
const args = process.argv.slice(2);

const result = spawnSync("cargo", args, {
  stdio: "inherit",
  env,
  cwd: path.join(__dirname, ".."),
  shell: true,
});

process.exit(result.status ?? 1);
