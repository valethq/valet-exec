import { describe, expect, test } from "bun:test";
import { activationRunner } from "../src/index";
import { detachedRunner, pickRunner } from "../src/runner";

describe("activationRunner", () => {
  test.each([undefined, "auto", "detached"] as const)("keeps a successful %s selection", async (want) => {
    const calls: unknown[] = [];
    const warnings: unknown[] = [];
    const runner = await activationRunner(
      want,
      { warn: (...args) => void warnings.push(args) },
      async (w) => {
        calls.push(w);
        return detachedRunner;
      },
    );
    expect(runner).toBe(detachedRunner);
    expect(calls).toEqual([want]);
    expect(warnings).toEqual([]);
  });

  test("an unavailable explicit runner warns and retries auto", async () => {
    const calls: unknown[] = [];
    const warnings: unknown[] = [];
    const runner = await activationRunner(
      "launchd",
      { warn: (...args) => void warnings.push(args) },
      async (want) => {
        calls.push(want);
        if (want === "launchd") return pickRunner(want, "linux");
        return detachedRunner;
      },
    );
    expect(runner).toBe(detachedRunner);
    expect(calls).toEqual(["launchd", "auto"]);
    expect(warnings).toEqual([
      [
        "configured runner unavailable; falling back to auto",
        { runner: "launchd", error: 'runner "launchd" needs macOS' },
      ],
    ]);
  });

  test.each([undefined, "auto"] as const)("a failed %s selection is not retried", async (want) => {
    const calls: unknown[] = [];
    const warnings: unknown[] = [];
    await expect(
      activationRunner(want, { warn: (...args) => void warnings.push(args) }, async (w) => {
        calls.push(w);
        throw new Error("auto failed");
      }),
    ).rejects.toThrow("auto failed");
    expect(calls).toEqual([want]);
    expect(warnings).toEqual([]);
  });

  test("a failed fallback propagates without another retry", async () => {
    const calls: unknown[] = [];
    await expect(
      activationRunner("launchd", { warn() {} }, async (want) => {
        calls.push(want);
        throw new Error(want === "auto" ? "auto failed" : "unavailable");
      }),
    ).rejects.toThrow("auto failed");
    expect(calls).toEqual(["launchd", "auto"]);
  });
});
