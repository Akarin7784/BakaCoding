# @bakacoding/workspace

模块 4 工作区与受限工具层：每单 Git worktree，read/write/edit/glob/grep 五个受限文件工具与三级权限。

## 文件工具（T-010）

`createTools({ ticket_id, worktree_path, permission_list })` 返回 `{ read, write, edit, glob, grep }`，每个都是 `(input: unknown) => Promise<ToolResult>`，`ToolResult` 为 `{ ok: true, output }` 或 `{ ok: false, code, message }`，在结构上满足模块 5 的 `CreateFileTools`。`FILE_TOOL_DEFINITIONS` 是五个工具的 JSON Schema 定义，名称和参数对齐 DeepSeek Harness（tag dsh-v0.2.1-alpha.5）完整模式：

| 工具 | 参数 |
| --- | --- |
| `read` | `file_path`，`offset`（从 1 起，默认 1），`limit`（默认且最多 2000 行） |
| `write` | `file_path`，`content`（整文件） |
| `edit` | `file_path`，`old_string`，`new_string`，`replace_all`（默认 false） |
| `glob` | `pattern`（不含 `/` 时按文件名匹配任意深度），`path`；最多 100 条，按修改时间新到旧 |
| `grep` | `pattern`（JavaScript 正则，逐行匹配），`path`（文件或目录），`include`（一个 glob）；最多 250 条匹配，按文件分组带行号 |

规则：

- **先读后写**：已存在的文件必须先 `read` 才能 `write` / `edit`，否则 `FS_NOT_OBSERVED`；读过以后被改动（版本号 `dev:ino:size:mtimeNs:ctimeNs`）报 `FS_STALE_VERSION`。新文件可以直接 `write`，缺的父目录自动建。每次 `createTools` 一套独立的已读记录。
- **edit**：字面量匹配，不模糊；没找到 `FS_EDIT_NOT_FOUND`，多处匹配又没给 `replace_all` 报 `FS_AMBIGUOUS_EDIT`。比较时 CRLF 统一成 LF，写回保留文件原来的换行风格（同 harness）。
- **失败时文件不动**：写入走同目录临时文件再 rename，已存在文件保留权限位。
- **外层硬边界**：路径一律相对工作区根；绝对路径（含 Windows 盘符）、`..` 越界、文件或中间目录经符号链接指向工作区外、悬空符号链接，都报 `FS_OUTSIDE_WORKSPACE`。`.git`、`.env` / `.env.*` / `.envrc` / `.envrc.*`（任一段，大小写不敏感）和私钥类文件（`id_rsa` 等、`.netrc`、`.pgpass`、`*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.jks` / `*.keystore`）报 `FS_PROTECTED_PATH`，权限清单给 `rw` 也不放行。例外：文件名为 `.env.example`（大小写不敏感）的文件可以读、glob、grep（仍要权限清单放行），写和改照样报 `FS_PROTECTED_PATH`；名为 `.env.example` 的目录仍整个受保护。glob / grep 结果里直接跳过受保护文件。不提供 shell、网络、git。
- **权限清单**：`[{ glob, level }]`，按顺序匹配，后面的条目覆盖前面的（同 `.gitignore`），未匹配即拒绝。读要 `ro` 或 `rw`，写要 `rw`，不够报 `FS_PERMISSION_DENIED`。符号链接的链接路径和真实路径都要过。清单登记在 `PermissionRegistry`（默认 `defaultPermissionRegistry`，只在本进程内存里）；`applyPermissions(ticket_id, list)` 整份替换后，同一单已建好的工具立刻按新清单判定。
- **越界写申请（T-011）**：`createTools` 传 `scope_requests: { bus, ctx, timeout_ms? }` 后，write / edit 被权限清单拒绝时发 `write_scope_requested`，等同一 `request_id` 的 `write_scope_granted`（批准范围以 `rw` 追加到清单末尾再判）或 `write_scope_denied`；拒绝或超时（默认 5 分钟）报 `FS_PERMISSION_DENIED` 带原因。受保护路径、工作区外路径不申请。不传就直接拒绝。`bus` 只需结构上兼容模块 0 的 `EventBus`，本包不依赖总线。
- **grep 防正则回溯（T-011）**：正则超过 1000 字符报 `FS_INVALID_INPUT`；语法在主线程先检查，匹配在独立线程里跑，一次调用总时长超过 `grep_timeout_ms`（默认 10 秒）就终止线程，报 `FS_GREP_TIMEOUT`。
- **工具定义深冻结（T-011）**：`FILE_TOOL_DEFINITIONS` 每一层（含 `input_schema`）都冻结，序列化字节与之前一致。
- 其他错误码：`FS_INVALID_INPUT`、`FS_NOT_FOUND`、`FS_NOT_A_FILE`、`FS_NOT_A_DIRECTORY`、`FS_NOT_TEXT`（二进制）、`FS_FILE_TOO_LARGE`（超过 10 MiB）、`FS_IO_ERROR`。错误信息不带宿主机绝对路径。
