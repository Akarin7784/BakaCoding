# @bakacoding/pr

模块 6 PR 抽象：GitHub 真 PR 与本地 PR 记录两种实现，读 diff 与 CI check。

## GitHub 实现：远程 PR 在第一次提交之后才开（T-047）

- `open`：只建本地记录，并确保远程有集成分支；不推工作分支，不开远程 PR（这时分支还没有提交，GitHub 会回 422 No commits between）。
- `commitWorktree`：本地提交成功后只推本单分支（refspec `refs/heads/<branch>:refs/heads/<branch>`，快进），再开 base 为集成分支的 PR，已有同名 open PR 就复用。复投时推新提交，远程 PR 自动更新。
  - 不强推，不碰集成分支和 target。远程分支已分叉（非快进被拒）时上报 `github_manual` 并抛 `GithubBranchDivergedError`。
  - push 或开 PR 失败：本地提交保留，抛错；下次 `commitWorktree`、`merge` 或 `checks` 时补做。
- `openIntegration`：推集成分支；比 target 有新提交时才开 PR，否则等 `merge` 时补开。
- `merge`：没有 `remote` 时先补推、补开 PR；分支比 base 没有新提交就不推、不开 PR，抛错说明（不会 422）。合并前的 `pushForMerge` 保留，作兜底。
- `checks`：评审读 CI 用 push 之后的 head sha。未结束的单张记录取本单分支本地 HEAD；远程分支不是这个 sha 或还没有 `remote` 时先补推、补开 PR，补做失败抛错，不拿远程没有的 sha 去查（查不到会被当成没配 CI）。
- 本地实现行为不变。
