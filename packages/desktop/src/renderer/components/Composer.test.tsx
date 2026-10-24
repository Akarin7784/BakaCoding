// @vitest-environment jsdom
// UI-04b：Composer——chip 选项目 /「不指定」、空内容和只读置灰、Enter 发送与 Shift+Enter 换行。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./Composer";

afterEach(cleanup);

const projects = [
  { project_id: "p-1", name: "商城" },
  { project_id: "p-2", name: "后台" },
];

function Harness(props: Partial<ComposerProps> & { initial?: string }) {
  const [value, setValue] = useState(props.initial ?? "");
  const [pid, setPid] = useState<string | undefined>(props.projectId);
  return (
    <Composer
      projects={projects}
      onSend={() => {}}
      {...props}
      value={value}
      onChange={setValue}
      projectId={pid}
      onProjectChange={(id) => {
        setPid(id);
        props.onProjectChange?.(id);
      }}
    />
  );
}

/** jsdom 没有 PointerEvent，用键盘打开 radix 菜单 */
function openChip() {
  fireEvent.keyDown(screen.getByTestId("composer-chip"), { key: "Enter" });
}

const sendBtn = () => screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
const input = () => screen.getByLabelText("发给主管") as HTMLTextAreaElement;

describe("Composer（UI-04b）", () => {
  it("圆角框 radius 16，发送是图标按钮 aria-label=发送", () => {
    render(<Harness />);
    expect(screen.getByTestId("composer").className).toContain("rounded-[16px]");
    expect(sendBtn().textContent).toBe("");
    expect(sendBtn().querySelector("svg")).toBeTruthy();
  });

  it("内容为空（含只有空白）时发送置灰，有内容才可点", () => {
    render(<Harness />);
    expect(sendBtn().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "   " } });
    expect(sendBtn().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "加验证码" } });
    expect(sendBtn().disabled).toBe(false);
  });

  it("只读时输入框、chip、发送都禁用，Enter 也不发", () => {
    const onSend = vi.fn();
    render(<Harness readonly initial="有内容" onSend={onSend} />);
    expect(sendBtn().disabled).toBe(true);
    expect(input().disabled).toBe(true);
    expect((screen.getByTestId("composer-chip") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Enter 发送；Shift+Enter 不发送（留给换行）；组字中的 Enter 不发送", () => {
    const onSend = vi.fn();
    render(<Harness initial="第一行" onSend={onSend} />);
    const shift = fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(shift).toBe(true); // 没 preventDefault：浏览器照常插入换行
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    const enter = fireEvent.keyDown(input(), { key: "Enter" });
    expect(enter).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("chip 默认显示选中项目名；菜单里选另一个项目 / 不指定会回调", async () => {
    const onProjectChange = vi.fn();
    render(<Harness projectId="p-1" onProjectChange={onProjectChange} />);
    expect(screen.getByTestId("composer-chip").textContent).toContain("商城");
    openChip();
    fireEvent.click(await screen.findByRole("menuitem", { name: "后台" }));
    expect(onProjectChange).toHaveBeenLastCalledWith("p-2");
    expect(screen.getByTestId("composer-chip").textContent).toContain("后台");
    openChip();
    fireEvent.click(await screen.findByRole("menuitem", { name: "不指定" }));
    expect(onProjectChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByTestId("composer-chip").textContent).toContain("不指定");
  });
});
