# @bakacoding/coder-pool

模块 5 Flash 编码池：每单一个临时 Flash 代理，用模块 4 的五个文件工具直接改 worktree，跑完即销毁。接口和规则见 `docs/modules.md` 第 5 节。

## 公共前缀缓存

公共前缀 = 系统提示（`promptTemplate("coder")` + 结束协议 + 项目架构约束）+ 五个工具定义，放在每次模型调用的最前面，用于命中服务商的前缀缓存。

- 每次 `runTicket` 都重新取一次模板和该项目的架构约束，对内容 `JSON.stringify([template, constraints])` 算 sha256。
- 哈希与该项目缓存的一致：复用缓存里的同一个前缀字符串，逐字节不变。
- 哈希变了（模板或约束改了）：重拼前缀并替换缓存；改回原内容时，前缀也回到原来的字节。
- 缓存按 `project_id` 分，只在本进程内存里，重启后重新拼（内容相同则字节相同）。
- 工具定义是固定常量，只能在末尾追加；改动会让前缀快照测试失败。

## 不可信的 feedback

- `feedback` 先按码点截断到 `maxFeedbackChars`（默认 20000），再用 `@bakacoding/types` 的 `wrapUntrusted` 转义并包进 `<untrusted-<nonce> kind="feedback">` 区块。转义会把 `<` 换成 `&lt;`，所以结果可能略超 20000 字符上限。
- nonce 在 `createCoderPool` 时随机生成，同一池内不变，只出现在需求单之后（区块前就地说明标签名），不进公共前缀；前缀里只用通用说法描述「不可信区块」，所以不同 nonce 下前缀逐字节相同。
