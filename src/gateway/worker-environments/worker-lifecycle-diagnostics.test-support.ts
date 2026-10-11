export function createWorkerLifecycleLogger(
  original: typeof import("../../logging/subsystem.js"),
  info: (...args: unknown[]) => void,
) {
  return (name: string) => {
    const logger = original.createSubsystemLogger(name);
    return name === "gateway/worker-placement" ? { ...logger, info } : logger;
  };
}
