// T-040：10 的写入范围通配字符集必须与 4（T-054 SCOPE_WILDCARD）、8（T-053 SCOPE_REQUEST_WILDCARD）一致。
// 做法：按常量名从两边源码里抠出正则字面量（两者都是模块内私有常量，不为测试新增导出），
// 再拿全部可打印 ASCII 字符逐个比对三个正则的命中结果——比较的是行为而不是写法，
// 字符顺序、转义写法不同都不误报；哪边改了字符集、改了常量名或不再是正则字面量，这里都会失败。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GLOB_CHARS } from "./validate.js";

function extract(rel: string, name: string): RegExp {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const m = new RegExp(`const ${name} = /((?:\\\\.|[^/\\n])+)/([a-z]*);`).exec(src);
  if (!m) throw new Error(`${rel} 里找不到正则常量 ${name}`);
  return new RegExp(m[1]!, m[2]);
}

const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const hits = (re: RegExp) => ascii.filter((c) => re.test(c)).join("");

describe("写入范围通配字符集", () => {
  it("就是 * ? [ ] { } ( ) ! + @", () => {
    expect(hits(GLOB_CHARS)).toBe([..."!()*+?@[]{}"].sort().join(""));
  });
  it("与 4 的 SCOPE_WILDCARD（T-054）一致", () => {
    expect(hits(extract("../../workspace/src/tools.ts", "SCOPE_WILDCARD"))).toBe(hits(GLOB_CHARS));
  });
  it("与 8 的 SCOPE_REQUEST_WILDCARD（T-053）一致", () => {
    expect(hits(extract("../../sub-agent/src/sub-agent.ts", "SCOPE_REQUEST_WILDCARD"))).toBe(
      hits(GLOB_CHARS),
    );
  });
});
