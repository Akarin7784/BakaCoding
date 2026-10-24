// UI-07d：设置 › 项目的文案（组件和测试共用）。
export const PROJECT_COPY = {
  title: "已导入项目",
  empty: "还没有导入项目。",
  loading: "读取中…",
  loadFailed: "读取项目列表失败",
  noPath: "未记录仓库路径",
  openFolder: "打开所在文件夹",
  remove: "移除",
  confirmTitle: (name: string) => `移除项目「${name}」？`,
  confirmBody: "只移除 BakaCoding 里的这条项目记录，不删仓库里的任何文件，也不删历史事件。",
  confirmCancel: "取消",
  confirmOk: "移除",
  removeFailed: "移除项目失败",
  readonly: "只读模式下不能移除项目。",
} as const;
