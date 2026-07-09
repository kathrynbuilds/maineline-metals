function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function log(...args) {
  console.log(`[${stamp()}]`, ...args);
}

export function warn(...args) {
  console.warn(`[${stamp()}] WARN`, ...args);
}

export function error(...args) {
  console.error(`[${stamp()}] ERROR`, ...args);
}
