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
  unavailable: "这个版本还不能生成价格表，请更新到新版本",
  write_failed: "写入配置失败，原来的文件没有改动",
  verify_failed: "生成的配置没通过校验，已经撤回",
  failed: "生成配置失败，请重试",
};

/** 启动只读原因（T-113）：缺配置 / 配置不合法，准备页「生成配置」能修 */
export const CONFIG_MISSING_REASON = "缺少模型配置（config/models.json 或 config/pricing.json）";
export const CONFIG_INVALID_REASON = "模型配置不合法（config/models.json 或 config/pricing.json）";
