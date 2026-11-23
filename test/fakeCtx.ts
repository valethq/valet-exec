import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Audience, Caller, PluginContext, PolicyProvider, Role } from "@valethq/sdk";
import manifest from "../manifest.json";
import { kv, storage } from "./helpers";

export interface FakeOptions {
  roles?: Record<string, Role>;
  /** Grants every permission to trusted and owner subjects, like a policy that hands out `exec:*`. */
  policy?: boolean;
  config?: Record<string, unknown>;
}

export interface Fake {
  ctx: PluginContext<never>;
  asCalls: { principalId: string; runId?: string }[];
  messages: unknown[];
  topics: { prefix: string; opts: { permission: string; resource?: (topic: string) => unknown } }[];
  provided: Record<string, { list: (scope: unknown) => Promise<unknown[]> | unknown[] }>;
  disposers: (() => void | Promise<void>)[];
}

const noop = () => {};

export function fakeCtx(opts: FakeOptions = {}): Fake {
  const roles = opts.roles ?? {};
  const declared: Record<string, unknown> = Object.fromEntries(
    Object.entries(manifest.acl.permissions).map(([name, def]) => [`exec:${name}`, def]),
  );
  const fake: Fake = {
    ctx: undefined as never,
    asCalls: [],
    messages: [],
    topics: [],
    provided: {},
    disposers: [],
  };
  const policy: PolicyProvider = {
    check: (subject, permission) =>
      subject.role === "guest"
        ? { allow: false, by: "valet-policy", reason: `${permission} denied` }
        : { allow: true },
  };
  const store = {
    principals: { get: (id: string) => (roles[id] ? { id, displayName: id, role: roles[id] } : undefined) },
    sessions: { get: (id: string) => ({ id, projectId: "prj_1" }) },
    partTypes: { define: noop },
    as(actor: { principalId: string; runId?: string }) {
      fake.asCalls.push(actor);
      return { messages: { create: async (m: unknown) => void fake.messages.push(m) } };
    },
  };
  fake.ctx = {
    plugin: { id: "valet-exec", version: "0.0.0", dir: "", manifest },
    config: opts.config ?? { runner: "detached" },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    acl: { permission: (name: string) => declared[name], credential: () => undefined },
    scopes: {
      maybe: () => (opts.policy ? policy : undefined),
      provide: (name: string, provider: Fake["provided"][string]) => {
        fake.provided[name] = provider;
      },
    },
    store,
    storage: { sql: storage(), kv: kv() },
    paths: { data: mkdtempSync(join(tmpdir(), "valet-exec-fake-")), cache: "", valetHome: "" },
    events: { signal: noop, emit: async () => {}, after: noop, before: noop },
    ws: {
      publish: noop,
      topic: (prefix: string, o: Fake["topics"][number]["opts"]) => {
        fake.topics.push({ prefix, opts: o });
        return { dispose: noop };
      },
    },
    signal: new AbortController().signal,
    onConfigChange: noop,
    onDispose: (fn: () => void | Promise<void>) => void fake.disposers.push(fn),
  } as unknown as PluginContext<never>;
  return fake;
}

export const caller = (principalId?: string, audience?: Audience): Caller => ({
  plugin: "valet-agent",
  ...(principalId && { actor: { principalId, role: "owner", ...(audience && { audience }) } }),
});
