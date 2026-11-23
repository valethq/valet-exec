import {
  type AclContext,
  allowedTools,
  type Caller,
  type Decision,
  defineTool,
  type Role,
  type ToolDefinition,
  type ToolProvider,
} from "@valethq/sdk";

export const RUN_PERMISSION = "exec:run";

/**
 * spec-gap: a caller with no actor is refused outright; the doc only constrains actors and audiences, but `can` checks
 * it as a guest and a policy grant to guests must not yield a shell.
 */
export function shellDecision(ctx: AclContext, role: Role, caller: Caller | undefined): Decision {
  const deny = (reason: string): Decision => ({ allow: false, by: ctx.plugin.id, reason });
  const isOwner = (principalId: string) => ctx.store.principals.get(principalId)?.role === "owner";
  const actor = caller?.actor;
  if (role !== "owner" || !actor || !isOwner(actor.principalId)) return deny("shell access is owner-only");
  if (actor.audience?.tier !== undefined && actor.audience.tier !== "owner")
    return deny("shell output would reach non-owners");
  const reader = actor.audience?.principals?.find((id) => !isOwner(id));
  return reader === undefined ? { allow: true } : deny(`shell output would reach non-owner ${reader}`);
}

export function shellTool<Input>(def: ToolDefinition<Input>, ctx: AclContext): ToolDefinition<Input> {
  const checked = defineTool(def, ctx);
  return {
    ...checked,
    invoke(input, call) {
      const d = shellDecision(ctx, call.role, call.caller);
      if (d.allow) return checked.invoke(input, call);
      return Promise.resolve({
        content: [{ type: "text", text: `${def.name} denied: ${d.reason}` }],
        isError: true,
      });
    },
  };
}

export function shellProvider(ctx: AclContext, tools: readonly ToolDefinition<never>[]): ToolProvider {
  return {
    list: (scope) =>
      shellDecision(ctx, scope.role, scope.caller).allow ? allowedTools(ctx, scope, tools) : [],
  };
}
