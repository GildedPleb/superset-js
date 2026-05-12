let hasRewrite = false;
let lastRewriteLength = 0;
const COLORS = {
  info: "\x1b[36;1m", // bold cyan
  warn: "\x1b[33;1m", // bold yellow
  error: "\x1b[31;1m", // bold red
  ok: "\x1b[32;1m", // bold green
  reset: "\x1b[0m",
};
function flushRewrite() {
  if (hasRewrite) {
    process.stdout.write("\n");
    hasRewrite = false;
  }
}

function logLine(level: string, message: string) {
  flushRewrite();
  const now = new Date();
  const timestamp = now.toLocaleString();
  const color = COLORS[level as keyof typeof COLORS] || "";
  console.log(
    `${timestamp} [${color}${level.toUpperCase()}${COLORS.reset}] ${message}${COLORS.reset}`,
  );
}

function info(message: string) {
  logLine("info", message);
}

function warn(message: string) {
  logLine("warn", message);
}

function error(message: string) {
  logLine("error", message);
}

function success(message: string) {
  logLine("ok", message);
}

export function createLogger(namespace: string) {
  return {
    info: (msg: string) => info(`[${namespace}] ${msg}`),
    warn: (msg: string) => warn(`[${namespace}] ${msg}`),
    error: (msg: string) => error(`[${namespace}] ${msg}`),
    success: (msg: string) => success(`[${namespace}] ${msg}`),
  };
}
