import { performance } from "node:perf_hooks";
import { LivyError } from "./errors";
import type { ApiClientLogger } from "./fabricApiClient";

export type ExecutionOutcome = "ok" | "error" | "cancelled";
export type StatementRole = "user" | "module-setup";
type ExecutionPhase =
  | "host.resolve"
  | "code.prepare"
  | "modules.prepare"
  | `queue.${StatementRole}`
  | "session.acquire"
  | "session.start"
  | "session.reattach"
  | "bootstrap.submit"
  | "bootstrap.wait"
  | `statement.submit.${StatementRole}`
  | `statement.wait.${StatementRole}`
  | "output.render"
  | "total";

let executionSequence = 0;

/** Client-observed spans; nested phases are not additive. No user data is logged. */
export class ExecutionDiagnostics {
  private readonly id = ++executionSequence;
  private readonly endTotal: (outcome: ExecutionOutcome) => void;

  constructor(
    private readonly logger?: ApiClientLogger,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.endTotal = this.begin("total");
  }

  begin(phase: ExecutionPhase): (outcome: ExecutionOutcome) => void {
    if (this.logger === undefined) {
      return () => undefined;
    }
    const started = this.now();
    return (outcome) => {
      try {
        this.logger?.debug(
          `[execution ${this.id}] phase=${phase} durationMs=${Math.max(0, this.now() - started).toFixed(0)} outcome=${outcome}`,
        );
      } catch {
        console.warn("[fabric-connect] Failed to write execution diagnostics.");
      }
    };
  }

  async measure<T>(
    phase: ExecutionPhase,
    action: () => PromiseLike<T>,
    outcome: (value: T) => ExecutionOutcome = () => "ok",
  ): Promise<T> {
    const end = this.begin(phase);
    try {
      const value = await action();
      end(outcome(value));
      return value;
    } catch (error) {
      end(executionFailureOutcome(error));
      throw error;
    }
  }

  finish(outcome: ExecutionOutcome): void {
    this.endTotal(outcome);
  }
}

export function executionFailureOutcome(error: unknown): ExecutionOutcome {
  return error instanceof LivyError && error.kind === "cancelled"
    ? "cancelled"
    : "error";
}
