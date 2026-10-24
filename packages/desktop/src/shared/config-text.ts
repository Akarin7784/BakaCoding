// T-113：生成配置与嵌套仓库的固定文案。主进程按码回这些文案，界面原样显示；不拼路径、配置值和原始报错。
import type { DesktopConfigFixFailure } from "./api.js";

/** 嵌套仓库（与 T-114 模块 4 的 RepoFixError("nested_repo") 文案一致） */
export const NESTED_REPO_REASON =
  "这个文件夹在另一个 Git 仓库里面。请导入上层仓库的根目录，或把文件夹移到仓库外再初始化";

export const CONFIG_FIX_TEXT: Record<DesktopConfigFixFailure["code"], string> = {
  cwd_repo: "还没选项目文件夹：请先导入项目，再准备仓库",
  not_git: "先初始化 Git，再生成配置",
  nested_repo: NESTED_REPO_REASON,
  external_config:
    "模型配置用的是 --config / BAKACODING_CONFIG 指定的文件，这里不生成，请直接改那个文件",
  invalid_budget: "每日预算必填：请填一个大于 0 的金额",
  confirm_required: "有不合法的配置文件要覆盖：请先确认（会先备份）",
  unsafe_path: "config 文件夹或配置文件是符号链接或不是普通文件，没有写入",
  template_missing: "找不到安装包里的配置模板，请重新下载安装包",
  unavailable: "这个版本还不能生成配置，请更新到新版本",
  write_failed: "写入配置失败，原来的文件没有改动",
  verify_failed: "生成的配置没通过校验，已经撤回",
  failed: "生成配置失败，请重试",
};

/** 启动只读原因（T-113）：缺配置 / 配置不合法，准备页「生成配置」能修 */
export const CONFIG_MISSING_REASON = "缺少模型配置（config/models.json 或 config/pricing.json）";
export const CONFIG_INVALID_REASON = "模型配置不合法（config/models.json 或 config/pricing.json）";

/** 设置 › 模型（UI-07b）的固定文案：主进程按码回这些，界面原样显示；不拼路径和配置值 */
export const MODEL_SETTINGS_TEXT = {
  external_config:
    "模型配置由启动参数指定（--config / BAKACODING_CONFIG），这里只读；请直接改那个文件后重启",
  cwd_repo: "还没选项目文件夹：请先导入项目，再改模型设置",
  read_failed: "读不到 config/models.json 或 config/pricing.json，请先在项目准备页生成配置",
  invalid_config: "当前模型配置不合法，请先在项目准备页修好再来这里改",
  invalid_input: "提交的设置格式不对，请刷新后重试",
  invalid: "有字段没通过校验，没有写入任何文件",
  unsafe_path: "config 文件夹或配置文件是符号链接或不是普通文件，没有写入",
  write_failed: "写入 config/models.json 失败，两个文件都没有改动",
  partial_write:
    "已写入 config/models.json，但写入 config/pricing.json 失败（单价没改）；后端没有重载，请修好后再保存一次",
  failed: "保存失败，请重试",
} as const;

/** 设置 › 预算（UI-07c）`budget:status` 的固定文案：不带路径、不带原始报错 */
export const BUDGET_STATUS_TEXT = {
  cwd_repo: "还没选项目文件夹：请先导入项目，再改预算",
  read_failed: "读不到 config/models.json，请先在项目准备页生成配置",
  invalid_config: "当前配置不合法，请先在项目准备页修好再来这里改预算",
  failed: "读取预算失败，请重试",
} as const;

/** UI-07d：设置 › 模型 / 预算在外部配置（--config / BAKACODING_CONFIG）下的统一只读提示。 */
export const EXTERNAL_CONFIG_READONLY_HINT = "配置来自外部文件，此页只读";
