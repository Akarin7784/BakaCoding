import { describe, expect, it } from "vitest";
import { EffortSchema } from "./index.js";

describe("@bakacoding/types 占位", () => {
  it("只接受四个思考档位", () => {
    expect(EffortSchema.parse("max")).toBe("max");
    expect(EffortSchema.safeParse("medium").success).toBe(false);
  });
});
