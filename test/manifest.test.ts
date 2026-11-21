import { expect, test } from "bun:test";
import manifest from "../manifest.json";

test("runner changes require a restart", () => {
  const runner = manifest.settings.sections.tools.subsections
    .flatMap((sub) => sub.items)
    .find((item) => item.id === "runner");
  expect(runner).toHaveProperty("apply", "restart");
});

test("numeric settings use unit-aware types and preserve their bounds and defaults", () => {
  const items = manifest.settings.sections.tools.subsections.flatMap((sub) => sub.items);
  for (const [id, type, min, value] of [
    ["yieldMs", "duration", 0, 10000],
    ["logRetentionDays", "number", 1, 14],
    ["headBytes", "bytes", 0, 2048],
    ["tailBytes", "bytes", 0, 30720],
  ] as const) {
    const input = items.find((item) => item.id === id)?.input;
    expect(input).toMatchObject({ type, min, default: value });
    expect(input).not.toHaveProperty("unit");
  }
  expect(items.find((item) => item.id === "yieldMs")?.input).toHaveProperty("max", 600000);
});
