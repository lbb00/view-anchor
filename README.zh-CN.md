<p align="center">
  <img src="https://raw.githubusercontent.com/lbb00/view-anchor/main/assets/banner.svg" alt="view-anchor — 让 DOM 之外的画面实时对齐 DOM 元素" width="820">
</p>

> 让 DOM 之外的画面实时对齐 DOM 元素：测量占位元素，逐帧同步最新矩形，拖拽无延迟。

[![npm version](https://img.shields.io/npm/v/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![npm downloads](https://img.shields.io/npm/dm/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![License](https://img.shields.io/npm/l/view-anchor)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)

[English](./README.md) · [简体中文](./README.zh-CN.md)

> [在线演示](https://lbb00.github.io/view-anchor/)：拖动分栏、切换面板或 3D 视角，查看外部画面如何跟随占位元素。

## 它解决什么问题

有些画面的位置不是由 CSS 直接控制：例如应用自己摆放的叠层、嵌入式文档，或能根据矩形定位的渲染表面。DOM 布局会移动占位元素，却不会自动更新这些画面的位置。

`view-anchor` 负责测量占位元素。元素尺寸变化或窗口大小变化时，它同步调用你提供的 `publish` 函数。函数怎么使用这个值由应用决定。

## `publish` 收到什么

`publish` 不是内置传输通道，而是一个同步回调。不同接口会传入不同的普通对象：

- `createViewAnchor` 调用 `publish(bounds)`。`bounds` 是相对视口、取整后的 CSS 像素矩形：`{ x, y, width, height }`。`present` 变为 `false` 时，会发布一次全零矩形，然后停止观察。
- `createPlacementAnchor` 在显示时调用 `publish({ visible: true, bounds })`，隐藏时调用 `publish({ visible: false })`。
- `createSizeAdvertiser` 调用 `publish({ axis, extent })`。`axis` 为 `block`（高度）或 `inline`（宽度），`extent` 是取整后且不小于零的内容尺寸。

数据已接收或已经入队时，返回 `true` 或不返回值；当前不能接收时才返回 `false`。下一次测量会重试被拒绝的值。

## 安装

```bash
pnpm add view-anchor
# 或
npm install view-anchor
```

React 是可选 peer dependency。Hook 从 `view-anchor/react` 导入；根入口为了兼容 `v0.1.2` 也会导出 `useViewAnchor`，因此导入根入口时需要安装 React。`view-anchor/protocol` 不需要 React。

## 使用

### 跟随一个 DOM 元素

```ts
import { createViewAnchor } from 'view-anchor'

const publish = (bounds) => {
  applyBoundsToExternalSurface(bounds)
}

const handle = createViewAnchor(placeholderEl, {
  present: true,
  publish,
})

handle.update({ present: true, publish }) // 更新选项并立即重新发布
handle.dispose() // 停止观察；之后不会再发布
```

默认的 `createViewAnchor` 监听 `ResizeObserver` 和窗口 `resize`。如果祖先滚动、transform 或拖拽会移动元素而不改变它自身尺寸，请使用下面的 `createPlacementAnchor`，按需开启 `followScroll` 或 `followGeometry`。

把 `present` 设为 `false` 会发布全零矩形并停止观察。你的 `publish` 函数可以把它解释为隐藏、移除，或保留外部画面。

`createViewAnchor`、`createPlacementAnchor`、`createSizeAdvertiser` 和 `createGeometryBatcher` 都支持 `signal`。调用 `AbortController.abort()` 的清理效果等同于 `dispose()`；创建前已经 abort 的 signal 不会开始测量或安装监听。

```ts
const controller = new AbortController()
const handle = createViewAnchor(placeholderEl, {
  present: true,
  publish,
  signal: controller.signal,
})

controller.abort()
```

### React

```tsx
import { useViewAnchor } from 'view-anchor/react'

function ExternalSurfaceContainer({ visible }: { visible: boolean }) {
  const ref = useViewAnchor({
    present: visible,
    publish: applyBoundsToExternalSurface,
  })

  return <div ref={ref} className="h-full w-full" />
}
```

元素卸载时，Hook 会先发布收起值，再释放监听。它兼容 React 18 和 19 的 StrictMode 重挂载。

### 显式可见性

全零矩形无法区分“已隐藏”和“可见但恰好是 0×0”。需要这个区分时使用 `Placement` API：

```ts
import { createPlacementAnchor } from 'view-anchor'

const handle = createPlacementAnchor(target, {
  visible: true,
  publish: applyPlacement,
  followScroll: true, // 祖先容器滚动时重新测量
  followGeometry: true, // 拖拽或滚动期间逐帧测量；稳定后停止
  guardDisplayNone: true, // 零面积或 display:none 时发布 { visible: false }
})

handle.pulse() // 例如在 CSS 过渡期间主动打开一段逐帧测量
```

React 版本为 `view-anchor/react` 导出的 `usePlacementAnchor`。

### 由内容决定占位尺寸

当外部画面的内容尺寸需要反过来调整占位元素时，在内容所在的文档中使用 `createSizeAdvertiser`：

```ts
import { createSizeAdvertiser } from 'view-anchor'

const handle = createSizeAdvertiser(contentWrapper, {
  axis: 'block', // 一个 advertiser 只负责一个轴：block = 高度，inline = 宽度
  publish: updatePlaceholderSize,
})

handle.update(updatePlaceholderSize) // 有当前尺寸时会立即重新报告
handle.dispose()
```

目标元素在它负责的轴上必须随内容伸缩。若应用也反过来在同一轴上强制设置尺寸，双方会互相触发布局，难以稳定。详见 [双向几何设计](./docs/bidirectional-design.md)。

### 需要传递、校验和排序时

核心只交付 `Bounds`、`Placement` 和 `AdvertisedSize`。如果应用需要把这些值交给别的页面、环境或异步通道，可选的 `view-anchor/protocol` 提供消息版本、输入校验、乱序过滤和微任务合并。

```ts
import {
  createGeometryBatcher,
  createPlacementMessagePublisher,
  decodeGeometryWireValue,
} from 'view-anchor/protocol'

// sendGeometryBatch 由应用实现：接收一个 batch，并同步返回是否已接收。
const batcher = createGeometryBatcher(sendGeometryBatch)
const publish = createPlacementMessagePublisher(
  { anchorId: 'editor', generation: 3 },
  batcher.publish,
)

const decoded = decodeGeometryWireValue(received, { maxMessages: 100 })
if (decoded.ok) {
  // 先验证来源，再只应用更新的消息。
}
```

同一个 `{ anchorId, generation }` 应只保留一个 publisher 实例。针对同一地址重新创建 publisher 会让序号回到 1，接收端会把新消息当作过期消息丢弃。需要重新开始时，把 `generation` 加一。

完整约定见 [通信协议](./docs/protocol.md)。

## 性能边界

- 相同的已发布矩形不会再次调用 `publish`。
- `followGeometry` 只在需要时启动动画帧轮询，稳定后停止。
- `createGeometryBatcher` 会合并同一微任务内的更新；每个锚点的位置和尺寸各保留最新值。
- `dispose()` 或 abort 会停止监听并释放长期持有的元素和回调引用。

性能数据和测量方式见 [性能报告](./docs/performance-report.md)。这些数据只用于比较同一台机器上的改动，不能代表浏览器布局、传递或应用业务的耗时。

## API

| 导出                                  | 类型        | 用途                                                                       |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| `createViewAnchor(target, opts)`      | 函数        | 测量 DOM 元素并调用 `publish({ x, y, width, height })`。全零矩形表示收起。 |
| `createPlacementAnchor(target, opts)` | 函数        | 发布带可见性的 `Placement`，可选滚动和几何跟随。                           |
| `measurePlacement(target)`            | 函数        | 读取当前矩形，返回 `{ visible: true, bounds }`。                           |
| `createSizeAdvertiser(target, opts)`  | 函数        | 用 `publish({ axis, extent })` 上报一个内容尺寸轴。                        |
| `useViewAnchor(opts)`                 | Hook        | 返回占位元素的 ref 回调。                                                  |
| `usePlacementAnchor(opts)`            | Hook        | `Placement` API 的 React 适配。                                            |
| `Bounds`                              | 类型        | `{ x, y, width, height }`，单位为 CSS 像素。                               |
| `Placement`                           | 类型        | `{ visible: true; bounds } \| { visible: false }`。                        |
| `AdvertisedAxis` / `AdvertisedSize`   | 类型        | 内容尺寸上报的轴和数据。                                                   |
| `view-anchor/protocol`                | 函数 + 类型 | 消息封装、校验、排序和批处理。                                             |

## 文档

- [机制说明](./docs/mechanism.md)：正向测量的触发条件、收起和 React 生命周期。
- [双向几何设计](./docs/bidirectional-design.md)：内容尺寸反向调整占位元素时的单轴约束。
- [通信协议](./docs/protocol.md)：消息格式、校验、排序和批处理。
- [性能报告](./docs/performance-report.md)：可复现的性能数据和测量环境。

## 参与贡献

提交前运行 `pnpm lint`、`pnpm format:check`、`pnpm check-types`、`pnpm test` 和 `pnpm build`。`pnpm benchmark` 用于更新性能报告。

## 许可证

[MIT](./LICENSE) © lbb00
