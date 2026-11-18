import type {
  ILivySessionManager,
  LivyTarget,
} from "../core/livySessionManager";
import type { PythonModuleMode } from "../core/moduleStaging";

export async function restartTrackedSessionAfterModeChange(
  transition:
    | { previous: PythonModuleMode; selected: PythonModuleMode }
    | undefined,
  target: LivyTarget | undefined,
  sessions: Pick<ILivySessionManager, "hasSession" | "stopSession">,
  restart: (target: LivyTarget) => Promise<void>,
): Promise<boolean> {
  if (
    transition?.previous !== "local" ||
    transition.selected !== "remote" ||
    target === undefined ||
    !sessions.hasSession(target)
  ) {
    return false;
  }
  await sessions.stopSession(target);
  await restart(target);
  return true;
}
