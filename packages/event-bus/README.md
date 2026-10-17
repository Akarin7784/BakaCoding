# @bakacoding/event-bus

模块 0 事件总线：进程内发布和订阅，只传递事件，不落库。

```ts
import { createEventBus, newTrace, childSpan } from "@bakacoding/event-bus";

const bus = createEventBus();
const off = bus.subscribe("*", async (e) => { /* 模块 2 落库 */ });
await bus.publish({ type: "review_backlog", ...childSpan(trace), requirement_id, ticket_id: null, payload: { pending: 3, capacity: 2 } });
```

语义：

- `publish` 先用 `@bakacoding/types` 的 `EventSchema` 校验，失败直接 reject，谁都收不到，也不占用 `seq`。
- `seq` 由总线分配，从 0 开始连续递增；`event_id`（默认 UUID）和 `ts`（ISO 8601 UTC）发布方没给就由总线补。
- 异步分发：`publish` 返回前不会同步调用任何 handler；返回的 Promise 在所有订阅者处理完后 resolve，值是补全后的事件。
- 每个订阅者按发布顺序串行收到事件；不同订阅者之间互不阻塞。
- handler 抛错或 reject：只交给 `onHandlerError`（默认 `console.warn`），不影响其他订阅者，`publish` 也不 reject；不会再发成事件，避免循环。
- span 由发布方生成：新需求用 `newTrace()` 开一条 trace（一个需求一条），往下用 `childSpan(parent)`。
