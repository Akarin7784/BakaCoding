import { describe, expect, it } from "vitest";
import { MODULE_ID, MODULE_NAME } from "./index.js";

describe("@bakacoding/event-bus 占位", () => {
  it("导出模块编号和包名", () => {
    expect(MODULE_ID).toBe(0);
    expect(MODULE_NAME).toBe("@bakacoding/event-bus");
  });
});
