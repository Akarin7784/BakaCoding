// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App";

afterEach(cleanup);

const openProject = () => fireEvent.click(screen.getByRole("button", { name: /baka-todo/ }));

describe("桌面界面壳子", () => {
  it("默认显示对话列表和主管 1:1，右侧边栏关闭", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "对话列表" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "主管对话" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "右面板" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出诊断包" })).toBeTruthy();
  });

  it("主管 1:1 可以输入并发送", () => {
    render(<App />);
    const box = screen.getByRole("textbox", { name: "发给主管" });
    fireEvent.change(box, { target: { value: "加个导出按钮" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByText("加个导出按钮")).toBeTruthy();
  });

  it("项目群只读：群里没有输入框（下方是主管对话，T-072），话题可折叠，Flash 调用默认折叠", () => {
    render(<App />);
    openProject();
    const group = screen.getByRole("region", { name: "项目群" });
    expect(group.querySelector("textarea")).toBeNull();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByLabelText("发给主管")).toBeTruthy();
    expect(document.getElementById("topic-req-1")?.tagName).toBe("DETAILS");
    const calls = screen.getAllByTestId("flash-calls");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect((c as HTMLDetailsElement).open).toBe(false);
  });

  it("打开右侧边栏后三栏齐全：编码池状态、Git 区、PR 列表", () => {
    render(<App />);
    openProject();
    fireEvent.click(screen.getByRole("button", { name: "打开右面板" }));
    expect(screen.getByRole("complementary", { name: "右面板" })).toBeTruthy();
    expect(screen.getByTestId("pool-status").textContent).toContain("并发 1/4");
    expect(screen.getByRole("button", { name: /合入 main/ })).toBeTruthy();
    const badge = screen.getByText("重写");
    expect(badge.getAttribute("data-tone")).toBe("accent");
    expect(screen.getByText("×1")).toBeTruthy();
  });

  it("主管带星标，副 Agent 同一机器人图标不带星", () => {
    render(<App />);
    openProject();
    expect(screen.getAllByTestId("icon-supervisor").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("icon-agent").length).toBeGreaterThan(0);
  });
});
