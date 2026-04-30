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

export function info(message: string) {
  logLine("info", message);
}

export function warn(message: string) {
  logLine("warn", message);
}

export function error(message: string) {
  logLine("error", message);
}

export function success(message: string) {
  logLine("ok", message);
}

export function rewriteLine(message: string) {
  const padding =
    lastRewriteLength > message.length
      ? " ".repeat(lastRewriteLength - message.length)
      : "";
  process.stdout.write(`\r${message}${padding}`);
  hasRewrite = true;
  lastRewriteLength = message.length;
}
