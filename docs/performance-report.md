# view-anchor 性能报告

本报告只保留当前工作树可由 `pnpm benchmark` 直接重建的绝对数据。命令启动 3 个全新的 Node.js 进程；每个进程预热 2 次、保留 7 个样本。CPU 表的“当前中位数”是三个进程中位数的中位数，完整 JSON 含全部 21 个原始样本。

本次环境：Node.js 24.18.0、macOS arm64、Apple M4（10 个逻辑核心）。这些数字只适合同机比较，不是浏览器布局、序列化或数据传递的耗时承诺。

## CPU

| 场景 | 数据量 | 当前中位数 | 三进程中位数（ms） |
| --- | ---: | ---: | --- |
| 所有锚点进入下一 generation | 10,000 | 1.5440ms | 1.5440、1.5517、1.4217 |
| 逐个 `clear(anchorId)` | 10,000 | 0.9214ms | 0.9230、0.8706、0.9214 |
| 已有 100,000 个历史锚点后只 flush 1 条 | 1 | 0.0067ms | 0.0059、0.0073、0.0067 |
| 发布 placement envelope | 1,000,000 次 | 6.6062ms | 6.3072、6.6649、6.6062 |
| 同一 anchor 连续 publish + flush | 100,000 次 | 8.4688ms | 8.0620、8.9530、8.4688 |
| 解码合法 batch | 100,000 条 | 2.7766ms | 2.6953、3.0069、2.7766 |
| 解码末项非法 batch | 100,000 条 | 3.2230ms | 3.3725、3.2230、2.9416 |
| sequence guard 接收并清理 | 100,000 条 | 11.5324ms | 11.5672、11.1703、11.5324 |
| `measurePlacement` | 1,000,000 次 | 8.0442ms | 8.0442、7.9074、8.1189 |

## 内存

每个状态在独立 Node.js 进程中执行，并在读数前显式 GC。表中为三个独立进程的中位数增量；heap 是 V8 保留堆，RSS 是进程常驻集合大小，二者不应混用。清理对象后，分配器也不一定立即把内存页归还给操作系统，所以 `afterClear` 的 RSS 不能当作仍有等量 JavaScript 对象存活。`dispose()` 会取消观察并释放目标元素与回调引用；这一行为由独立的 WeakRef 回归测试覆盖，不用下表的 RSS 来判断。

性能 harness 将 `queueMicrotask` 替换为 no-op，然后显式调用 `flush()`；这是刻意测量 batcher 的 pending/retained 状态，**不是**真实宿主 microtask 调度路径。

| 状态（100,000 个 anchor） | heap 增量 | RSS 增量 |
| --- | ---: | ---: |
| batcher 待 flush | 26,320,176B | 45,744,128B |
| batcher 成功 flush 后 | 13,304,000B | 43,548,672B |
| batcher `clear()` 后 | 34,560B | 39,895,040B |
| sequence guard 保留状态 | 14,088,840B | 27,246,592B |
| sequence guard `clear()` 后 | 19,568B | 23,576,576B |

## 实际导出代码体积

使用 Rolldown bundle、tree-shaking 和 minify，且将 `react` 作为 peer external。测量的是实际执行 JavaScript，不是 npm tarball、source map 或声明文件。

| 完整入口 | raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| `view-anchor` | 6,728B | 2,545B | 2,252B |
| `view-anchor/protocol` | 3,573B | 1,378B | 1,243B |
| `view-anchor/react` | 5,646B | 2,036B | 1,789B |

| 单独导出 | raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| `createViewAnchor` | 1,026B | 544B | 477B |
| `createPlacementAnchor` | 3,264B | 1,253B | 1,112B |
| `measurePlacement` | 283B | 195B | 168B |
| `createSizeAdvertiser` | 1,391B | 782B | 693B |
| `decodeGeometryWireValue` | 1,456B | 657B | 563B |
| `createGeometrySequenceGuard` | 395B | 255B | 222B |
| `createGeometryBatcher` | 1,380B | 639B | 586B |
| `createPlacementMessagePublisher` | 174B | 151B | 112B |
| `createSizeMessagePublisher` | 159B | 148B | 110B |
| `useViewAnchor` | 2,183B | 1,002B | 894B |
| `usePlacementAnchor` | 4,572B | 1,730B | 1,558B |

## V8 与边界

运行 `pnpm benchmark:v8 > /tmp/view-anchor-v8.log 2>&1` 时，三个新的 benchmark 进程会继承 `--trace-opt`、`--trace-deopt` 与 `--trace-turbo-inlining`。本文没有保留无对应当前 trace 工件的历史优化/反优化结论。

当前测量不覆盖真实浏览器布局、序列化、数据传递或生产工作负载；这些路径需在目标运行时另行测量。
