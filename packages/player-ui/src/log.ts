// Debug logging hook for package modules.  Hosts register their logger
// (the extension wires lib/env.ts::logDev — dev builds verbose, prod
// quiet; native shells wire console or nothing).  Default: silent.

type DebugLogger = (...args: unknown[]) => void;

let logger: DebugLogger = () => {};

export function setDebugLogger(fn: DebugLogger): void {
  logger = fn;
}

export function logDebug(...args: unknown[]): void {
  logger(...args);
}
