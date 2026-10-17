import { spawn } from "node:child_process";
import { SECRET_NAMES, type SecretName } from "./config.js";
import type { UserEnvStore } from "./secrets.js";

// T-088 / T-107：默认的 Windows 用户级环境变量实现。内部文件，不进 index。

/** 名字拼进 PowerShell 脚本前按白名单再核一次。 */
function assertName(name: SecretName): void {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) {
    throw new Error("不支持的密钥名");
  }
}

/** 默认 Windows 实现：值经 stdin 传给 PowerShell，不出现在命令行（进程列表看不到）。 */
export function powershellUserEnv(): UserEnvStore {
  const run = (script: string, stdin?: string) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      p.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
      p.on("error", () => reject(new Error("PowerShell 启动失败")));
      p.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(`PowerShell 退出码 ${String(code)}`)),
      );
      p.stdin.end(stdin ?? "");
    });
  return {
    async get(name) {
      assertName(name);
      const out = await run(
        `$v=[Environment]::GetEnvironmentVariable('${name}','User'); if ($null -ne $v) { [Console]::Out.Write('1' + $v) }`,
      );
      return out.startsWith("1") ? out.slice(1) : undefined;
    },
    async set(name, value) {
      assertName(name);
      await run(
        `[Console]::InputEncoding=[Text.Encoding]::UTF8; $v=[Console]::In.ReadToEnd(); [Environment]::SetEnvironmentVariable('${name}',$v,'User')`,
        value,
      );
    },
    async remove(name) {
      assertName(name);
      await run(`[Environment]::SetEnvironmentVariable('${name}',$null,'User')`);
    },
  };
}
