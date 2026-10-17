// UI-03b：密钥与测试连接的固定文案。主进程按码回这些文案，界面原样显示；不拼任何值、路径和原始报错。
import type { DesktopProviderTestCode, DesktopSecretFailure } from "./api.js";

export const SECRET_FAILURE_TEXT: Record<DesktopSecretFailure["code"], string> = {
  invalid_name: "不支持的密钥名",
  invalid_value: "密钥格式不对：不能为空、不能有换行，最长 4096 个字符",
  unsupported_platform: "只有 Windows 能在界面里保存密钥，请在系统里设置环境变量",
  write_failed: "没能写入用户环境变量，什么都没改，请重试",
  not_owned: "这个密钥来自系统环境变量，BakaCoding 不能清除，请在系统设置里改",
  not_set: "这个密钥还没有设置",
  failed: "操作失败，请重试",
};

export const PROVIDER_TEST_TEXT: Record<DesktopProviderTestCode, string> = {
  budget_exhausted: "今日预算已用完，没有发出请求（这不算连接失败）",
  no_secret: "还没有设置密钥，没有发出请求",
  auth_failed: "密钥无效或没有权限，请检查密钥",
  quota_exhausted: "服务商账户余额不足，请先去服务商那里充值",
  rate_limited: "请求太频繁，被服务商限流了，稍后再试",
  network: "连不上服务商，请检查网络或代理",
  config_error: "模型配置有问题：服务商或模型没配置，或者没有单价",
  http_error: "服务商返回了错误",
  invalid_target: "要测试的服务商或模型名不对",
  unavailable: "后端还没连上（只读模式），连上后才能测试连接",
  failed: "测试连接失败，请重试",
};
