let hasRewrite = false;
let lastRewriteLength = 0;

function flushRewrite() {
  if (hasRewrite) {
    process.stdout.write("\n");
    hasRewrite = false;
  }
}

function logLine(level: string, message: string) {
  flushRewrite();
  console.log(`[${level}] ${message}`);
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
  const padding = lastRewriteLength > message.length
    ? " ".repeat(lastRewriteLength - message.length)
    : "";
  process.stdout.write(`\r${message}${padding}`);
  hasRewrite = true;
  lastRewriteLength = message.length;
}
