# view-anchor 通信协议

`view-anchor` 的核心 API 只负责测量和调用同步 `publish`。可选入口 `view-anchor/protocol` 负责跨进程消息的版本、运行时校验、时序和批处理；它不绑定 Electron，也不替宿主做发送方授权。

## 消息

单条消息包含：

- `v: 1`：协议版本；未知版本直接拒绝。
- `kind`：`placement` 或 `size`。
- `anchorId`：宿主分配的逻辑锚点标识。
- `generation`：锚点重建时递增，隔离旧实例的迟到消息。
- `seq`：同一发布器内逐次递增。
- `placement` 或 `size`：原始几何载荷。

`generation` 对同一 `anchorId` 的所有消息类型生效：任一类型进入新代后，其他类型的旧代消息也会被拒绝。placement 与 size 发布器必须使用同一代次。`generation` 和 `seq` 只解决顺序，不是身份凭据。IPC 接收方必须先根据通道上下文校验 `senderFrame`、origin 或 capability token，并确认该发送方有权操作对应 `anchorId`。

## 发送

```ts
import {
  createGeometryBatcher,
  createPlacementMessagePublisher,
} from 'view-anchor/protocol'

const batcher = createGeometryBatcher(
  (batch) => ipc.send('geometry', batch),
  { onError: reportTransportError },
)

const publish = createPlacementMessagePublisher(
  { anchorId: 'editor', generation: 3 },
  batcher.publish,
)
```

`createPlacementMessagePublisher` 和 `createSizeMessagePublisher` 为每次尝试分配新的 `seq`，即使发送方返回 `false` 或抛错也不复用序号。

`createGeometryBatcher` 在当前任务末尾用一个 microtask 发送，不叠加渲染帧延迟。它按 `anchorId + kind` 合并，只保留更新的 `generation/seq`。下游发送返回 `false` 或抛错时，快照留在队列中；下一条有效消息或显式 `flush()` 会重试。所有下游 `send` 抛错（包括显式 `flush()`）都会由可选 `onError` 接收，且 `flush()` 返回 `false`；未提供 `onError` 时同样不会向调用方抛出。锚点销毁时调用 `clear(anchorId)` 释放它的队列和高水位；`clear()` 清理全部锚点但保留批处理器，`dispose()` 则永久停用它。

## 接收

```ts
import {
  createGeometrySequenceGuard,
  decodeGeometryWireValue,
} from 'view-anchor/protocol'

const order = createGeometrySequenceGuard()
const result = decodeGeometryWireValue(event.payload, { maxMessages: 100 })

if (result.ok) {
  const messages = result.value.kind === 'batch'
    ? result.value.messages
    : [result.value]

  for (const message of messages) {
    if (
      authorize(event.senderFrame, message.anchorId) &&
      order.accept(message)
    ) applyGeometry(message)
  }
}
```

解码器接收 `unknown`，不抛异常，并拒绝未知版本/类型、非法整数、负尺寸、非有限数值、无效载荷和超过 `maxMessages` 的批次。宿主仍需按自己的 viewport 和策略限制最终尺寸；解码通过不等于发送方已获授权。

## 发布失败契约

所有核心 `Publisher<T>` 都是同步函数：返回 `false` 表示没有接收，返回 `true` 或 `void` 表示已接收。核心只有在接收成功后才保留去重基线，因此失败值可在下次观察触发时重试；抛出的异常会原样传给调用方。Promise 不属于这个边界，异步发送应先把值可靠地放入调用方自己的队列，再同步报告是否入队成功。

为了兼容现有调用方，`view-anchor` 根入口仍发布原始 `Bounds`、`Placement` 和 `AdvertisedSize`；只有显式使用 `view-anchor/protocol` 才会加消息外壳。
