import type { IsolationContext } from "./protocol.js";

export function validIsolation(value: unknown): value is IsolationContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.teamId === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(v.teamId)
    && typeof v.conversationId === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(v.conversationId)
    && Number.isSafeInteger(v.generation) && Number(v.generation) > 0;
}

export function sameIsolation(a: IsolationContext | undefined, b: IsolationContext): boolean {
  return !!a && a.teamId === b.teamId && a.conversationId === b.conversationId && a.generation === b.generation;
}

/** A reset is irreversible, including delayed opens and queued work. Shared by both managers. */
export class IsolationGuard {
  private retired = new Map<string, number>();
  constructor(private readonly runtimeTeamId = process.env.PROVIDER_TEAM_ID) {}

  allows(context: IsolationContext): boolean {
    return validIsolation(context) && (!this.runtimeTeamId || context.teamId === this.runtimeTeamId)
      && context.generation > (this.retired.get(context.conversationId) ?? 0);
  }

  allowsTeam(teamId: string): boolean { return !this.runtimeTeamId || teamId === this.runtimeTeamId; }
  get teamRequired(): boolean { return !!this.runtimeTeamId; }

  retire(context: IsolationContext): void {
    if (validIsolation(context)) this.retired.set(context.conversationId, Math.max(context.generation, this.retired.get(context.conversationId) ?? 0));
  }
}
