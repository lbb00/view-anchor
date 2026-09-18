<p align="center">
  <img src="https://raw.githubusercontent.com/lbb00/view-anchor/main/assets/banner.svg" alt="view-anchor — 让 DOM 之外的画面实时对齐 DOM 元素" width="820">
</p>

> 让 DOM 之外的画面实时对齐 DOM 元素：测量占位元素，逐帧同步最新矩形，拖拽无延迟。

[![npm version](https://img.shields.io/npm/v/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![npm downloads](https://img.shields.io/npm/dm/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![License](https://img.shields.io/npm/l/view-anchor)](./LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md)

> [在线演示](https://lbb00.github.io/view-anchor/)：直接在倾斜的 3D 场景里拖动分隔条、滚动页面、点击按钮。画面 A 跟随占位元素；画面 B 把自己的内容高度报回页面，页面据此调整它的占位。

## 它解决什么问题

有些画面的位置由应用自己摆放（叠层、嵌入式文档或能根据矩形定位的渲染表面）。DOM 布局会移动占位元素，但不会自动更新这些画面的位置。

`view-anchor` 负责测量占位元素，在尺寸变化或窗口大小变化时同步调用你提供的 `publish` 函数。函数如何使用这个值由应用决定。

## `publish` 收到什么

`publish` 是一个同步回调，不同接口会传入不同的普通对象：

- `createViewAnchor` 在显示时调用 `publish({ visible: true, bounds })`（`bounds` 是相对视口、取整后的 CSS 像素矩形 `{ x, y, width, height }`），隐藏时调用 `publish({ visible: false })`。显式的 `visible` 用于区分“可见但恰好是 0×0”和“已隐藏或未挂载”。
- `createSizeAnchor` 调用 `publish({ axis, extent })`。`axis` 为 `block`（高度）或 `inline`（宽度），`extent` 是目标元素在该轴上的 border-box 尺寸（包含 padding 和 border；浏览器不提供 border-box 时退回 content-box），单位 CSS 像素，取整且不小于零。

数据已接收或已经入队时，返回 `true` 或不返回值；当前不能接收时才返回 `false`，下一次测量会重试被拒绝的值。隐藏状态下不再测量，所以被拒绝的 `{ visible: false }` 不会自动重发，需要再调用一次 `update()`；`useViewAnchor` 会在卸载时替你补发。

## 安装

```bash
pnpm add view-anchor
# 或
npm install view-anchor
```

React 是可选 peer dependency，只有从 `view-anchor/react` 导入时才需要。根入口（`view-anchor`）和 `view-anchor/protocol` 不依赖 React，未安装 React 也能加载。

## 使用

### 跟随一个 DOM 元素

```ts
import { createViewAnchor } from 'view-anchor'

const publish = (placement) => {
  if (placement.visible) applyBoundsToExternalSurface(placement.bounds)
  else hideExternalSurface()
}

const handle = createViewAnchor(placeholderEl, {
  visible: true,
  publish,
  followScroll: true, // 祖先容器滚动时重新测量
  followGeometry: true, // 拖拽或滚动期间逐帧测量；稳定后停止
  treatZeroAreaAsHidden: true, // 零面积或 display:none 时发布 { visible: false }
  holdSelector: '[role="separator"]', // 默认值；命中该选择器的 pointerdown 按住期间保持 followGeometry 开启，传 null 关闭
  dedupe: true, // 默认值；传 false 让每次测量都发布，即使值没变
})

handle.update({ visible: true, publish }) // 更新选项并立即重新发布
handle.pulse() // 位置变了但没有任何观察器能感知时（如一次类名切换让目标移动了但尺寸没变）主动重测；稳定后自动停止
handle.dispose() // 停止观察；之后不会再发布
```

把 `visible` 设为 `false` 会发布 `{ visible: false }` 并停止观察。你的 `publish` 函数可以把它解释为隐藏、移除，或保留外部画面。

`createViewAnchor`、`createSizeAnchor` 和 `createGeometryBatcher` 都支持 `signal`。调用 `AbortController.abort()` 的清理效果等同于 `dispose()`；创建前已经 abort 的 signal 不会开始测量或安装监听。

```ts
const controller = new AbortController()
const handle = createViewAnchor(placeholderEl, {
  visible: true,
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
    visible,
    publish: applyPlacementToExternalSurface,
    followScroll: true,
    followGeometry: true,
  })

  return <div ref={ref} className="h-full w-full" />
}
```

元素卸载时，Hook 会先发布 `{ visible: false }`，再释放监听。它兼容 React 18 和 19 的 StrictMode 重挂载，不会因此发布过期帧。

它每次调用都会重新应用选项，规则与 `createViewAnchor` 和 `update()` 一致：省略任何一项都会重置为默认值，而不是沿用上次的值。省略 `treatZeroAreaAsHidden`、`followScroll` 或 `followGeometry` 会重置为 `false`；省略 `holdSelector` 会重置为 `[role="separator"]`；省略 `dedupe` 会重置为 `true`。要关闭 `holdSelector` / `dedupe`，传 `null` / `false`。

### 由内容决定占位尺寸

当外部画面的内容尺寸需要反过来调整占位元素时，在内容所在的文档中使用 `createSizeAnchor`：

```ts
import { createSizeAnchor } from 'view-anchor'

const publish = updatePlaceholderSize

const handle = createSizeAnchor(contentWrapper, {
  axis: 'block', // 一个 size anchor 只负责一个轴：block = 高度，inline = 宽度
  publish,
})

handle.update({ publish }) // 应用新选项并立即重新报告当前尺寸；省略 dedupe 会重置为 true
handle.dispose()
```

目标元素在它负责的轴上必须随内容伸缩。若应用也反过来在同一轴上强制设置尺寸，双方会互相触发布局，难以稳定。详见 [双向几何设计](./docs/bidirectional-design.md)。

### 需要传递、校验和排序时

核心只交付 `Bounds`、`Placement` 和 `SizeMeasurement`。如果应用需要把这些值交给别的页面、环境或异步通道，可选的 `view-anchor/protocol` 提供消息版本、输入校验、乱序过滤和微任务合并。

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

- 默认去重：与上一次已发布的 `Placement`/尺寸完全相同不会再次调用 `publish`；传 `dedupe: false` 可以让每次测量都发布。
- `followGeometry` 只在需要时启动动画帧轮询，稳定后停止。
- `createGeometryBatcher` 会合并同一微任务内的更新；每个锚点的位置和尺寸各保留最新值。
- `dispose()` 或 abort 会停止监听并释放长期持有的元素和回调引用。

与 0.2.2 的对比和导出体积见 [性能报告](./docs/performance-report.md)。

## API

| 导出                                     | 类型        | 用途                                                                                                                                 |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `createViewAnchor(target, opts)`         | 函数        | 发布带可见性的 `Placement`，可选 `followScroll`、`followGeometry`、`treatZeroAreaAsHidden`、`holdSelector`、`dedupe`，含 `pulse()`。 |
| `measurePlacement(target)`               | 函数        | 读取当前矩形，返回 `{ visible: true, bounds }`。                                                                                     |
| `createSizeAnchor(target, opts)`         | 函数        | 用 `publish({ axis, extent })` 上报一个内容尺寸轴。                                                                                  |
| `useViewAnchor(opts)`                    | Hook        | `createViewAnchor` 的 React 适配，返回占位元素的 ref 回调。                                                                          |
| `Bounds`                                 | 类型        | `{ x, y, width, height }`，单位为 CSS 像素。                                                                                         |
| `Placement`                              | 类型        | `{ visible: true; bounds } \| { visible: false }`。                                                                                  |
| `Publisher<T>` / `PublishResult`         | 类型        | `publish` 回调的签名及其返回值（`void \| boolean`）。                                                                                |
| `ViewAnchorOptions` / `ViewAnchorHandle` | 类型        | `createViewAnchor` 的选项与句柄。                                                                                                    |
| `UseViewAnchorOptions` / `ViewAnchorRef` | 类型        | `useViewAnchor` 的选项与 ref 类型。                                                                                                  |
| `SizeAxis` / `SizeMeasurement`           | 类型        | 内容尺寸上报的轴和数据。                                                                                                             |
| `SizeAnchorOptions` / `SizeAnchorHandle` | 类型        | `createSizeAnchor` 的选项与句柄。                                                                                                    |
| `view-anchor/protocol`                   | 函数 + 类型 | 消息封装、校验、排序和批处理。                                                                                                       |

## 版本承诺

1.x 版本内，`view-anchor` 不会删除或重命名 `.`、`view-anchor/react`、`view-anchor/protocol` 的任何公开导出，也不会改变已有合法输入的默认行为。minor 版本只新增功能，patch 版本只修 bug。要移除的接口会先标记为废弃，等到 2.0 才真正删除。

## 文档

- [机制说明](./docs/mechanism.md)：正向测量的触发条件、默认去重与 `dedupe: false`、可见性与 React 生命周期。
- [双向几何设计](./docs/bidirectional-design.md)：内容尺寸反向调整占位元素时的单轴约束。
- [通信协议](./docs/protocol.md)：消息格式、校验、排序和批处理。
- [性能报告](./docs/performance-report.md)：性能结论和导出体积。

## 参与贡献

提交前运行 `pnpm lint`、`pnpm format:check`、`pnpm check-types`、`pnpm test` 和 `pnpm build`。`pnpm benchmark` 用于更新性能报告。

## 许可证

[MIT](./LICENSE) © lbb00
