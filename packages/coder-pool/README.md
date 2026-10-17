# @bakacoding/coder-pool

模块 5 Flash 编码池：每单一个临时 Flash 代理，用模块 4 的五个文件工具直接改 worktree，跑完即销毁。接口和规则见 `docs/modules.md` 第 5 节。

## 文件工具（T-034）

- 发给模型的工具定义是模块 4 的 `FILE_TOOL_DEFINITIONS`，工具执行默认用模块 4 的 `createTools({ ticket_id, worktree_path, permission_list })`；`deps.createTools` 只在测试或接线时注入替身。参数名以模块 4 为准：`read(file_path, offset?, limit?)`、`write(file_path, content)`、`edit(file_path, old_string, new_string, replace_all?)`、`glob(pattern, path?)`、`grep(pattern, path?, include?)`。
- 模块 4 的拒绝（`FS_OUTSIDE_WORKSPACE`、`FS_PROTECTED_PATH`、`FS_PERMISSION_DENIED`、`FS_INVALID_INPUT` 等）原样作为工具结果交还模型，本单继续。
- `changed_files`：成功的 `write` / `edit` 的 `file_path`，按模块 4 的规则规范成相对 worktree 的路径（反斜杠转 `/`、去 `./`、合并 `..`），去重，按首次修改顺序。

## 公共前缀缓存

公共前缀 = 系统提示（`promptTemplate("coder")` + 结束协议 + 项目架构约束）+ 五个工具定义，放在每次模型调用的最前面，用于命中服务商的前缀缓存。

- 每次 `runTicket` 都重新取一次模板和该项目的架构约束，对内容 `JSON.stringify([template, constraints])` 算 sha256。
- 哈希与该项目缓存的一致：复用缓存里的同一个前缀字符串，逐字节不变。
- 哈希变了（模板或约束改了）：重拼前缀并替换缓存；改回原内容时，前缀也回到原来的字节。
- 缓存按 `project_id` 分，只在本进程内存里，重启后重新拼（内容相同则字节相同）。
- 工具定义直接用模块 4（`@bakacoding/workspace`）的 `FILE_TOOL_DEFINITIONS`，加载时深拷贝并深冻结；只能在末尾追加，改动会让前缀快照测试失败（模块 4 改了工具说明也会触发，需要同时更新快照）。

## 不可信的 feedback

- `feedback` 先按码点截断到 `maxFeedbackChars`（默认 20000），再用 `@bakacoding/types` 的 `wrapUntrusted` 转义并包进 `<untrusted-<nonce> kind="feedback">` 区块。转义会把 `<` 换成 `&lt;`，所以结果可能略超 20000 字符上限。
- nonce 在 `createCoderPool` 时随机生成，同一池内不变，只出现在需求单之后（区块前就地说明标签名），不进公共前缀；前缀里只用通用说法描述「不可信区块」，所以不同 nonce 下前缀逐字节相同。

## 取消与思考回传（T-044）

- 模型调用用模块 1 的 `chat()`：`deps.chat` 可以直接传 `gateway.chat`（`ModelChat` 是它的子集）。
- `runTicket({ …, signal? })`：`signal` 原样传给每次 `chat()`，没传就不带这个字段。进入时、每次调模型前、每个工具调用前、返回 `turn_limit` 前都检查；已中止时抛 `signal.reason`（没有则抛名为 `AbortError` 的错误），不返回部分结果。
  - 请求发出前取消：模块 1 不发请求、不发 `call_completed`；发出后取消：模块 1 中止请求，`call_completed.error.code = ABORTED`，它抛的 `AbortError` 由 5 改抛 `signal.reason`。
  - 模型取消后才返回的那一轮整轮丢弃，不执行它的工具调用。已开始的工具调用不打断，跑完后不再执行同一轮剩下的工具。
- 思考内容：每轮 `chat()` 返回的 `reasoning`（`{ text, signature? }[]`）原样放进这一轮的 assistant 消息（含 `signature`，不改写、不截断），之后的请求带着全部历史，由模块 1 按协议回传（DeepSeek 带 tools 时必须回传，否则 400）。那一轮没有思考内容（缺省或空数组）就不带 `reasoning` 字段。
- 思考和 signal 都不进 `system` / `tools`，公共前缀和它的快照不变。
