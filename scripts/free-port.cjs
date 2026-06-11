/**
 * Free a TCP port by stopping processes in LISTEN state (dev server orphans).
 * Usage: node scripts/free-port.cjs [port]
 */
const { execSync } = require("child_process");

const DEFAULT_PORT = 1420;

function parsePids(output) {
  return [...new Set(
    output
      .split(/[\r\n\s]+/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid),
  )];
}

function killPid(pid) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

function findListeningPids(port) {
  if (process.platform === "win32") {
    try {
      const ps = [
        `Get-NetTCPConnection -LocalPort ${port} -State Listen`,
        "-ErrorAction SilentlyContinue",
        "| Select-Object -ExpandProperty OwningProcess -Unique",
      ].join(" ");
      const out = execSync(`powershell -NoProfile -Command "${ps}"`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parsePids(out);
    } catch {
      try {
        const out = execSync(`netstat -ano | findstr :${port}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const pids = [];
        for (const line of out.split(/\r?\n/)) {
          if (!line.includes("LISTENING")) continue;
          const parts = line.trim().split(/\s+/);
          const pid = Number.parseInt(parts[parts.length - 1], 10);
          if (Number.isInteger(pid) && pid > 0) pids.push(pid);
        }
        return [...new Set(pids)];
      } catch {
        return [];
      }
    }
  }

  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parsePids(out);
  } catch {
    return [];
  }
}

function freePort(port = DEFAULT_PORT) {
  const pids = findListeningPids(port);
  if (pids.length === 0) return 0;

  let killed = 0;
  for (const pid of pids) {
    if (killPid(pid)) {
      killed += 1;
      console.log(`[free-port] stopped PID ${pid} on port ${port}`);
    }
  }
  return killed;
}

if (require.main === module) {
  const port = Number.parseInt(process.argv[2] || String(DEFAULT_PORT), 10);
  freePort(port);
}

module.exports = { freePort, DEFAULT_PORT };
