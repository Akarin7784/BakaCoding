// T-090：ledgerSummary 只返回项目累计；参数校验。
import type { LedgerBreakdown } from "@bakacoding/types";
import { describe, expect, it } from "vitest";
import { ledgerSummary } from "./index.js";

const B: LedgerBreakdown = {
  total_micro_usd: 9,
  resubmit_micro_usd: 1,
  entries: 2,
  by_role: { coder: 9, sub_agent: 0, reviewer: 0, supervisor: 0 },
};

describe("T-090 ledgerSummary", () => {
  it("返回 { project }，按 project_id 调 totalsByProject", async () => {
    const calls: string[] = [];
    const ledger = {
      async totalsByProject(id: string) {
        calls.push(id);
        return B;
      },
    };
    const r = await ledgerSummary(ledger, { project_id: "P-1" });
    expect(r).toEqual({ project: B });
    expect(Object.keys(r)).toEqual(["project"]);
    expect(calls).toEqual(["P-1"]);
  });

  it("project_id 为空或不是字符串报 invalid_project_id，不查台账、消息不带值", async () => {
    let called = 0;
    const ledger = {
      async totalsByProject() {
        called++;
        return B;
      },
    };
    for (const bad of ["", 7, null, undefined, { x: "/home/eva" }]) {
      const err = await ledgerSummary(ledger, { project_id: bad as string }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TypeError);
      expect((err as { code?: string }).code).toBe("invalid_project_id");
      expect((err as Error).message).not.toMatch(/7|home/);
    }
    expect(called).toBe(0);
  });
});
