import { describe, expect, it } from "vitest";
import { IPC_CHANNELS, type IpcMainLike } from "../shared/api.js";
import { aboutInfo, buildCommit } from "./about.js";
import { serveAbout } from "./ipc.js";

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...a: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (c, l) => void handlers.set(c, l),
    removeHandler: (c) => void handlers.delete(c),
  };
  return { ipc, handlers, invoke: (c: string) => handlers.get(c)!({ sender: { id: 1 } }) };
}

const SHA = "cbd3b41aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5";
const PATHY = [
  "/home/eva/BakaCoding",
  "C:\\Users\\eva\\BakaCoding",
  "1.0.0/../../etc/passwd",
  "D:\\a b\\c",
  "~/x",
  "\\\\server\\share",
];

describe("app:about（UI-07a）", () => {
  it("正常值原样给出", () => {
    expect(
      aboutInfo({
        version: "1.0.0-preview.1",
        commit: SHA.toUpperCase(),
        electron: "43.8.0",
        chrome: "140.0.7339.0",
        node: "22.19.0",
      }),
    ).toEqual({
      version: "1.0.0-preview.1",
      commit: SHA,
      runtime: { electron: "43.8.0", chrome: "140.0.7339.0", node: "22.19.0" },
    });
  });

  it.each(PATHY)("像路径的值（%s）一律换成 null，结果里不带路径", (p) => {
    const r = aboutInfo({ version: p, commit: p, electron: p, chrome: p, node: p });
    expect(r).toEqual({
      version: null,
      commit: null,
      runtime: { electron: null, chrome: null, node: null },
    });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/[\\/]/);
    expect(text).not.toContain("eva");
  });

  it("非字符串 / 太短的 commit 是 null", () => {
    expect(aboutInfo({ version: 1, commit: "abc" }).commit).toBeNull();
    expect(aboutInfo({ version: undefined, commit: { sha: SHA } }).version).toBeNull();
  });

  it("IPC：注册、取值抛错时回全 null（不透出错误）、可注销", () => {
    const { ipc, handlers, invoke } = fakeIpcMain();
    let raw = () => ({ version: "1.0.0", commit: `${SHA} /home/eva/secret` });
    const stop = serveAbout(ipc, () => raw());
    expect(invoke(IPC_CHANNELS.appAbout)).toMatchObject({ version: "1.0.0", commit: null });
    raw = () => {
      throw new Error("ENOENT /home/eva/BakaCoding/package.json");
    };
    const r = invoke(IPC_CHANNELS.appAbout);
    expect(JSON.stringify(r)).not.toContain("/home");
    expect(r).toMatchObject({ version: null, commit: null });
    stop();
    expect(handlers.has(IPC_CHANNELS.appAbout)).toBe(false);
  });

  it("测试 / tsc 环境没有构建期 commit", () => {
    expect(buildCommit()).toBeNull();
  });
});
