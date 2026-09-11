# view-anchor 性能报告

本报告只保留当前工作树可由 `pnpm benchmark` 直接重建的绝对数据。命令启动 3 个全新的 Node.js 进程；每个进程预热 2 次、保留 7 个样本。CPU 表的“当前中位数”是三个进程中位数的中位数，完整 JSON 含全部 21 个原始样本。

本次环境：Node.js 24.18.0、macOS arm64、Apple M4（10 个逻辑核心）。这些数字只适合同机比较，不是浏览器、Electron IPC 或 DOM layout 的耗时承诺。

## CPU

| 场景 | 数据量 | 当前中位数 | 三进程中位数（ms） |
| --- | ---: | ---: | --- |
| 所有锚点进入下一 generation | 10,000 | 1.7407ms | 1.5772、1.7407、1.8334 |
| 逐个 `clear(anchorId)` | 10,000 | 1.0757ms | 1.0757、1.0241、1.0794 |
| 已有 100,000 个历史锚点后只 flush 1 条 | 1 | 0.0082ms | 0.0102、0.0068、0.0082 |
| 发布 placement envelope | 1,000,000 次 | 7.2710ms | 7.4852、7.2113、7.2710 |
| 同一 anchor 连续 publish + flush | 100,000 次 | 8.8899ms | 8.8899、8.8434、9.2207 |
| 解码合法 batch | 100,000 条 | 3.0990ms | 3.0990、2.9431、3.2170 |
| 解码末项非法 batch | 100,000 条 | 3.3382ms | 3.3195、3.6282、3.3382 |
| sequence guard 接收并清理 | 100,000 条 | 12.8928ms | 12.9085、12.8928、12.8151 |
| `measurePlacement` | 1,000,000 次 | 8.9269ms | 8.9269、8.5498、9.0800 |

## 内存

每个状态在独立 Node.js 进程中执行，并在读数前显式 GC。表中为三个独立进程的中位数增量；heap 是 V8 保留堆，RSS 是进程常驻集合大小，二者不应混用。清理对象后，分配器也不一定立即把内存页归还给操作系统，所以 `afterClear` 的 RSS 不能当作仍有等量 JavaScript 对象存活。

性能 harness 将 `queueMicrotask` 替换为 no-op，然后显式调用 `flush()`；这是刻意测量 batcher 的 pending/retained 状态，**不是**真实宿主 microtask 调度路径。

| 状态（100,000 个 anchor） | heap 增量 | RSS 增量 |
| --- | ---: | ---: |
| batcher 待 flush | 26,320,176B | 45,858,816B |
| batcher 成功 flush 后 | 13,303,872B | 43,696,128B |
| batcher `clear()` 后 | 34,432B | 40,026,112B |
| sequence guard 保留状态 | 14,088,840B | 27,099,136B |
| sequence guard `clear()` 后 | 19,568B | 23,461,888B |

## 实际导出代码体积

使用 esbuild bundle、tree-shaking 和 minify，且将 `react` 作为 peer external。测量的是实际执行 JavaScript，不是 npm tarball、source map 或声明文件。

| 完整入口 | raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| `view-anchor` | 6,627B | 2,588B | 2,297B |
| `view-anchor/protocol` | 3,581B | 1,412B | 1,276B |
| `view-anchor/react` | 5,472B | 2,023B | 1,797B |

| 单独导出 | raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| `createViewAnchor` | 987B | 528B | 472B |
| `createPlacementAnchor` | 3,246B | 1,246B | 1,120B |
| `measurePlacement` | 282B | 196B | 167B |
| `createSizeAdvertiser` | 1,350B | 780B | 680B |
| `decodeGeometryWireValue` | 1,472B | 664B | 570B |
| `createGeometrySequenceGuard` | 396B | 258B | 229B |
| `createGeometryBatcher` | 1,357B | 637B | 579B |
| `createPlacementMessagePublisher` | 200B | 165B | 135B |
| `createSizeMessagePublisher` | 185B | 162B | 129B |
| `useViewAnchor` | 2,116B | 984B | 885B |
| `usePlacementAnchor` | 4,421B | 1,718B | 1,549B |

## V8 与边界

运行 `pnpm benchmark:v8 > /tmp/view-anchor-v8.log 2>&1` 时，三个新的 benchmark 进程会继承 `--trace-opt`、`--trace-deopt` 与 `--trace-turbo-inlining`。本文没有保留无对应当前 trace 工件的历史优化/反优化结论。

当前测量不覆盖真实浏览器/Electron、DOM layout、structured clone、IPC 或生产工作负载；这些路径需在目标运行时另行测量。
