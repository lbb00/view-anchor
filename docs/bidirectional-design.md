# 双向几何设计

view-anchor 支持双向几何同步：

- **正向（`createViewAnchor`）**：宿主测量 DOM 占位元素的位置和尺寸，通过 `publish(bounds)` 发送给主进程或外部容器，更新原生视图（如 `WebContentsView.setBounds`）。
- **反向（`createSizeAdvertiser`）**：下游视图内部测量自身内容尺寸，通过 `publish(size)` 通知宿主调整占位大小，宿主再通过正向更新视图位置。

常见场景：嵌套在宿主中的工具栏或面板，其宽度由宿主布局决定，高度则由子视图自身的内容决定。

## 1. 为什么正向走同步、反向走 RAF

两个方向在性能和交互上的要求不同，因此没有共用同一套调度逻辑：

- **正向（`createViewAnchor`）采用同步发布。**
  原生视图的 `setBounds` 需要跨进程通信，相比渲染进程本身的页面绘制通常已经有大约一帧的延迟。如果测量和发布再走一次 `requestAnimationFrame`，拖拽时就会产生两帧以上的视觉延迟，出现明显的边框脱节。因此正向在 `ResizeObserver` 和窗口 `resize` 回调中**同步测量并发布**，高频触发的防抖则依赖前后数值的比对（相同矩形直接跳过）。
- **反向（`createSizeAdvertiser`）采用 RAF 调度（`createMeasureLoop`）。**
  反向构成了一条跨进程的反馈环：下游上报尺寸 → 宿主调整占位大小 → 下游重新布局与测量 → 再次上报。在这个链路中，将上报频率限制在每帧至多一次（与屏幕刷新率对齐）能够有效避免高频震荡，同时提供平滑的缓冲。

## 2. 反向接口说明

```ts
export type AdvertisedAxis = 'block' | 'inline'

export interface AdvertisedSize {
  readonly axis: AdvertisedAxis   // 固定轴，供宿主做白名单检查
  readonly extent: number         // 内容尺寸（CSS 像素），四舍五入且 >= 0
}

export interface SizeAdvertiserOptions {
  axis: AdvertisedAxis            // 创建后固定，每个 advertiser 只负责一条轴
  publish: Publisher<AdvertisedSize> // 接收尺寸发布的回调
}

export interface SizeAdvertiserHandle {
  update(publish: Publisher<AdvertisedSize>): void // 切换 publish 回调
  dispose(): void                                  // 停止监听并取消 RAF
}

export function createSizeAdvertiser(
  target: HTMLElement,
  opts: SizeAdvertiserOptions,
): SizeAdvertiserHandle
```

- 运行在下游视图的渲染环境中；从 `ResizeObserverEntry.borderBoxSize` 直接读取尺寸，避免在回调中触发 `getBoundingClientRect` 引起强制回流（reflow）。
- 上报前会执行 `Math.round` 取整并钳位至 `>= 0`。
- 目标元素 `target` 应当在所负责的轴上根据内容自适应（shrink-to-fit），不能被宿主设置的尺寸反向影响。
- 如果需要同时汇报宽和高，应当针对不同轴分别创建两个独立的 advertiser，而不是放在同一条消息中，以保持数据流向的清晰。

## 3. 单轴控制与收敛性

为了避免死循环，必须遵循单轴控制原则：

- 一个 advertiser 只测量并上报它负责的那条轴；另一条轴由宿主通过 `setBounds` 单向传入，下游只读。
- 典型案例：宿主决定宽度，下游决定高度。因为高度是内容流式排版的结果而不是输入，整个尺寸传递是一条单向有向无环图（DAG），更新可以在单步内收敛。
- 如果下游的高度又反过来改变了下游的宽度（或测量了 `<body>`/`<html>`），就会形成跨进程的循环调整，导致界面抖动。

## 4. 职责与信任边界

下游视图可能运行不可信或第三方代码，因此上报的尺寸应当被当作不可信输入处理。

| 职责 | 负责方 | 说明 |
|---|---|---|
| 数值取整 | view-anchor | 避免传递非整数像素 |
| 过滤 NaN / Infinity | view-anchor | 丢弃异常无效数值 |
| 负数归零 | view-anchor | 保证尺寸非负，反映真实测量结果 |
| 视口限制（clamp） | 宿主 | 依据当前窗口可用空间对上报值做范围约束，防止异常大值 |
| 发送方身份校验 | 宿主 | 在接收 IPC 或 postMessage 时验证 senderFrame、origin 或 token |
| 轴白名单校验 | 宿主 | 检查 `axis` 是否与宿主预期的控制轴一致 |
| 位置与层级锁定 | 宿主 | 下游不能擅自修改自身的坐标位置或 z-index |

**针对错误选择 target 的提醒**：
如果把 `target` 设为 `document.body` 或 `documentElement`，其尺寸直接等于宿主给定的视口大小，会导致无法正确收缩。对此 `createSizeAdvertiser` 在初始化时提供了一次性控制台警告，帮助快速排查问题。

## 5. 宿主与下游的配合方式

正向与反向并不直接通信，它们通过宿主中的**占位 DOM 元素**进行连接：

- 下游的 `createSizeAdvertiser` 将内容尺寸通知宿主，宿主更新占位元素的高度。
- 宿主的 `createViewAnchor` 监听占位元素的矩形变化，将新位置同步给外部视图。

```
宿主渲染进程                          宿主主进程           下游渲染进程（如工具栏页面）
──────────                          ────────            ────────────────────────────
[占位 div]                                               [内容容器（自适应高度）]
  │ ▲                                                      │
  │ │ ② 宿主校验并更新占位高度                             │ ① createSizeAdvertiser
  │ │    div.style.height = clamp(size.extent)             │    测量容器高度
  │ └─────────── IPC / postMessage ◀───────────────────────┘    publish(size) ──▶
  │
  │ ③ 占位尺寸变化，ResizeObserver 触发
  │    测量占位新矩形 → publish(bounds)
  ▼
  ──── IPC ──▶ ④ view.setBounds(bounds) ──▶ [WebContentsView / 原生视图]
                                               │ 视图尺寸更新，下游视口变化
                                               └──▶ 下游内容重新排版（单步收敛）
```

1. **下游**：通过 `createSizeAdvertiser` 测量高度并通过 IPC 发给宿主。
2. **宿主**：对收到的高度做合规性限制（例如限制在 `minHeight` 和 `maxHeight` 之间），并写入占位 div 的样式。
3. **宿主**：占位 div 尺寸改变，`createViewAnchor` 的 `ResizeObserver` 触发，测量出新的绝对矩形并发给主进程。
4. **宿主主进程**：调用 `setBounds` 更新原生视图位置与尺寸。

## 6. 与 Electron preferred-size 的关系

在纯 Electron 环境下，也可以使用 `enablePreferredSizeMode` 和 `preferred-size-changed` 事件由 Electron 主进程自动获取网页期望大小。

view-anchor 的反向方案是平台无关的实现，适用于跨域 iframe、第三方 webview 或需要针对特定内部 DOM 节点测量尺寸的场景。两者并不冲突，可以根据具体的宿主架构按需选择。
