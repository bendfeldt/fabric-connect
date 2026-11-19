import type {
  ILivySessionManager,
  LivyTarget,
} from "../core/livySessionManager";
import type { PythonModuleMode } from "../core/moduleStaging";

export async function restartTrackedSessionAfterModeChange(
  transition:
    | {
        previous: PythonModuleMode;
        selected: PythonModuleMode;
        wheelChanged?: boolean;
      }
    | undefined,
  target: LivyTarget | undefined,
  sessions: Pick<ILivySessionManager, "hasSession" | "stopSession">,
  restart: (target: LivyTarget) => Promise<void>,
): Promise<boolean> {
  const shouldRestart =
    transition !== undefined &&
    ((transition.previous !== transition.selected &&
      (transition.previous === "wheel" ||
        transition.selected === "wheel" ||
        (transition.previous === "local" &&
          transition.selected === "remote"))) ||
      transition.wheelChanged === true);
  if (!shouldRestart || target === undefined || !sessions.hasSession(target)) {
    return false;
  }
  await sessions.stopSession(target);
  await restart(target);
  return true;
}
