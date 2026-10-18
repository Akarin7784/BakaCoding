# Windows 测试基线（T-125）

> 建立日期：2026-10-18 · 测量时 main：`10ac6e3` · 维护：审查官（T-125 跟踪）
>
> 本机是 Windows 开发机，测试套件里有一批**平台可移植性问题**（不能创建符号链接、没有 `mkfifo`、POSIX 路径断言、Windows 文件锁/子进程句柄），在 Linux 上不会出现。本文把这些 main 上的**确定性失败**固化成清单，作为 PR 门禁基线：**新增失败必须为 0**。

## 1. 门禁口径（T-125 起生效）

1. `build` / `typecheck` / `lint` / `format:check` 必须全绿；
2. 测试只跑**受影响包**的全量：`pnpm exec vitest run --no-file-parallelism packages/<pkg>`，与 main 同包串行结果比；
3. 出现 5s 超时 / `EBUSY`，先串行单文件复跑，仍红才算新增失败；
4. 报「受影响包绿 + 新增失败 = 0」，**禁止报「全量绿」**（这台机做不到全量绿，也不该拿它当门禁）。

## 2. 基线数据（测量时 main `10ac6e3`）

- 套件总量：**118 个测试文件 / 2205 条**（2035 过 + 163 失败 + 7 skip，三个开发并行、机器高负载下的全量跑）；
- 全量并发跑失败：163 条 / 26 文件（含大量负载噪声）；
- 串行复核 + 两次运行交叉比对后的**确定性失败：55 条 / 21 文件**（本文第 3 节）；
- 其余 108 条是负载噪声（5s 默认超时 60 条、`EBUSY` 等），串行复跑即消失，**不计入基线**。

> 之后 main 若只合 docs / 纯配置改动，测试内容与本文数据不变；合业务代码后 PR 比较只看「同包同名失败」，不看总数。

## 3. 确定性失败清单（55 条 / 21 文件）

| 模块 | 文件 | 条数 | 归因 | 修复方向 |
|---|---|---|---|---|
| 2 存储 | `storage/src/storage-followup.test.ts` | 3 | 文件权限 EPERM×1、seq 升级断言×2 | 清理重试；两条 seq 断言需模块 2 复核 Windows 下的实际差异 |
| 3 配置预算 | `config-budget/src/project.test.ts` | 6 | 无符号链接权限×2、无 `mkfifo`×3、EACCES×1 | 能力探测 skip；`mkfifo` 用例 `it.skipIf(win32)` |
| 3 配置预算 | `config-budget/src/secrets.test.ts` | 2 | HKCU 写失败模拟（Windows 下不成立） | 换失败注入方式或 win32 skip |
| 4 工作区 | `workspace/src/tools.test.ts` | 5 | 无符号链接权限×5 | 能力探测 skip 或 junction 替代 |
| 4 工作区 | `workspace/src/cleanup.test.ts` | 7 | 符号链接×1、EPERM×2、数组断言×3、`git worktree add` 失败×1 | 探测 skip；目录删除加 Windows 重试；断言改平台无关 |
| 4 工作区 | `workspace/src/cleanup-managed.test.ts` | 1 | EPERM | 删除重试 |
| 4 工作区 | `workspace/src/repo.test.ts` | 1 | 超时场景断言（Windows 下不抛 `RepoFixError`） | 复核 Windows 下 git 超时行为后改断言 |
| 4 工作区 | `workspace/src/worktree.test.ts` | 1 | cleanup 结果数组断言 | 改平台无关断言 |
| 6 PR | `pr/src/git-timeout.test.ts` | 7 | 子进程/文件锁 EBUSY×7 | 与 T-123（Windows 进程树结束）一起修；afterEach 等句柄释放 + 重试删除 |
| 6 PR | `pr/src/integration.test.ts` | 2 | EBUSY×2 | 同上 |
| 6 PR | `pr/src/github.test.ts` | 1 | EBUSY×1 | 同上 |
| 6 PR | `pr/src/index.test.ts` | 2 | 慢测试超 5s×1、merge `target_dirty` 断言×1 | 慢测试单独放宽超时；断言复核 |
| 8 副 Agent | `sub-agent/src/integration.test.ts` | 1 | 无符号链接权限×1 | 能力探测 skip |
| 12 桌面 | `desktop/src/electron/project-import.test.ts` | 6 | 路径分隔符×1、符号链接×5 | 路径断言 toPosix；符号链接探测 skip（范式见 §6） |
| 12 桌面 | `desktop/src/electron/backend.test.ts` | 2 | 路径分隔符×1、来源断言×1 | 断言前 toPosix / `path.normalize` |
| 12 桌面 | `desktop/src/electron/backend-reload.test.ts` | 1 | 路径分隔符×1 | 同上 |
| 12 桌面 | `desktop/src/electron/reader.test.ts` | 1 | 路径分隔符×1 | 同上 |
| 12 桌面 | `desktop/src/design-rules.test.ts` | 1 | `path.relative` 返回反斜杠 | 断言前 `replaceAll("\\", "/")` |
| 组合根 | `app/src/create-default-deps.test.ts` | 1 | 路径分隔符×1 | toPosix / `path.normalize` |
| 组合根 | `app/src/user-main-worktree.test.ts` | 3 | 路径分隔符×3 | 同上 |
| 组合根 | `app/src/repo-git.test.ts` | 1 | git 输出 `C:/` 与原生 `\` 不一致 | 断言前 `path.normalize` |

## 4. 归因桶（合计 55）

| 归因 | 条数 | 说明 |
|---|---|---|
| Windows 无符号链接 / 文件权限 EPERM | 18 | 本机账户没有创建符号链接的权限；能建链接的机器（有开发者模式 / Linux）照常跑 |
| 路径分隔符 / POSIX 断言 | 10 | 测试用 `/a`、`components/x` 这类 POSIX 期望，Windows 实际是 `C:\a`、`components\x` |
| Windows 无 `mkfifo` | 3 | POSIX 命名管道设施 |
| EBUSY / 子进程句柄 | 10 | 子进程（git 等）句柄未释放就删目录；与 T-123 同源 |
| Windows 下不成立的模拟断言 | 13 | HKCU 写失败、`chmod` EACCES、git worktree/超时失败模拟 |
| 慢测试超过默认 5s | 1 | 按包串行时不紧张，可按需单独放宽 |

## 5. 平台守卫按模块分摊

原则：
- 优先**运行时能力探测 + skip**，不要整文件无条件 `skipIf(win32)`（会丢掉 Windows 覆盖）；
- 能改成平台无关断言的先改断言（路径统一 `path.normalize` / toPosix），别用 skip 掩盖；
- 修好一条就从本文清单删一条，并在 `docs/progress.md` 的 T-125 行记一笔。

| 模块 | 负责 | 要处理的文件 |
|---|---|---|
| 2 存储 | 基础开发 | `storage-followup.test.ts` |
| 3 配置预算 | 基础开发 | `config-budget/project.test.ts`、`secrets.test.ts` |
| 4 工作区 | 基础开发 | `workspace/tools`、`cleanup`、`cleanup-managed`、`repo`、`worktree` |
| 6 PR | 执行开发 | `pr/git-timeout`、`integration`、`github`、`index`（EBUSY 与 T-123 一起修） |
| 8 副 Agent | 编排开发 | `sub-agent/integration.test.ts` |
| 组合根 | 编排开发 | `app/create-default-deps`、`user-main-worktree`、`repo-git` |
| 12 桌面 | 界面开发 | `desktop/electron/project-import`、`backend`、`backend-reload`、`reader`、`design-rules` |

## 6. 推荐范式：符号链接能力探测

T-081 的 `default-config.test.ts` 已经用了运行时探测，其他模块照抄：

```ts
function canCreateSymlink(): boolean {
  const d = mkdtempSync(join(tmpdir(), "bc-sym-probe-"));
  try {
    symlinkSync(d, join(d, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const SYMLINK_OK = canCreateSymlink();

it.skipIf(!SYMLINK_OK)("config/ 或目标文件是符号链接：拒绝，不写到链接另一头", () => {
  // ...
});
```

## 7. 维护规则

- 增删本文清单必须由**审查官复核**并在群里报备，同时更新「测量时 main」和日期；
- 每次 PR 门禁只比「受影响包的同名失败集合」，超时/EBUSY 先串行复跑；
- 不允许为了让 PR 过闸把新增失败偷偷塞进基线；
- T-125 跟踪消除进度：每去掉一条在上面清单里删除，并在 `docs/progress.md` 的 T-125 行更新剩余条数。

## 8. 复跑方法（附录）

```powershell
# 隔离 worktree，避免和别人的工作树互相干扰；LF 检出（本机 system gitconfig core.autocrlf=false 已设置，T-124 也加了 .gitattributes）
git -C <repo> -c core.autocrlf=false worktree add --detach ..\wt-base origin/main
cd ..\wt-base
pnpm install --frozen-lockfile
pnpm build; pnpm lint; pnpm format:check
pnpm exec vitest run --no-file-parallelism packages/<pkg>
```

- 全量 `pnpm test` 只用于**重建基线**，不用于 PR 门禁（三个开发并行时全量必然一堆超时）；
- 本机测量原始日志（不入仓）：`review/baseline-10ac6e3.log`（全量）、`review/main-test-serial.log`（串行交叉验证）。
