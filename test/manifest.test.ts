import { expect, test } from "bun:test";
import { join } from "node:path";
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

test("core parses unit strings, accepts fractional days, and rejects fractional bytes", () => {
  const core = process.env.VALET_CORE_DIR ?? join(import.meta.dir, "..", "..", "valet-core");
  const modelPath = join(core, "packages/core/src/settings/model.ts");
  const manifestPath = join(import.meta.dir, "..", "manifest.json");
  const result = Bun.spawnSync([
    process.execPath,
    "--eval",
    `
      const { buildModel, parseValues, validateValues } = await import(${JSON.stringify(modelPath)});
      const model = buildModel(await Bun.file(${JSON.stringify(manifestPath)}).json());
      const errors = {};
      const values = parseValues(model, {
        logRetentionDays: 1.5, yieldMs: "5s", headBytes: "8 KiB", tailBytes: "8 KiB"
      }, errors);
      console.log(JSON.stringify({
        values,
        errors: { ...errors, ...validateValues(model, values) },
        fractionalBytes: validateValues(model, { ...values, headBytes: 1.5, tailBytes: 1.5 })
      }));
    `,
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const checked = JSON.parse(result.stdout.toString());
  expect(checked.values).toEqual({ logRetentionDays: 1.5, yieldMs: 5000, headBytes: 8192, tailBytes: 8192 });
  expect(checked.errors).toEqual({});
  expect(checked.fractionalBytes).toHaveProperty("headBytes");
  expect(checked.fractionalBytes).toHaveProperty("tailBytes");
});
