<p align="center">
  <img src="https://raw.githubusercontent.com/lbb00/view-anchor/main/assets/banner.svg" alt="view-anchor — 让 DOM 之外的画面贴合 DOM 元素" width="820">
</p>

> 高性能几何桥接库，让任何"不在 DOM 里的东西"始终贴合某个 DOM 元素：Electron 的 `WebContentsView`、其他桌面壳里的原生 webview、跨域 iframe，或者任何你能用一个矩形来定位的画面。每次移动和缩放都同步发布、不会重复发帧，整个包 gzip 后约 2.6 KB。

[![npm version](https://img.shields.io/npm/v/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![npm downloads](https://img.shields.io/npm/dm/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![License](https://img.shields.io/npm/l/view-anchor)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)

[English](./README.md) · [简体中文](./README.zh-CN.md)

> 🎮 **在线 Demo**：[3D 交互演示](https://lbb00.github.io/view-anchor/) 在浏览器里跑的是真实核心代码。拖动分栏、切换面板显示，看原生视图实时跟随。

## 要解决的问题

有些你想放进布局里的东西并不是 DOM 节点。Electron 的 `WebContentsView` 由主进程定位；其他桌面壳里的原生 webview 由宿主代码定位；跨域 iframe 里的文档只知道你通过 `postMessage` 告诉它的信息。而你的布局，不管是 flexbox、dockview 还是 react-resizable-panels，只会移动 DOM 节点，并不知道有别的东西需要正好盖在其中某个节点上面。

`view-anchor` 负责补上这一段。你把它指向一个占位元素，它测量这个元素，元素每次移动或缩放时，把新的矩形交给你的 `publish` 回调。接下来怎么用由你决定：在 Electron 里接 `ipcRenderer.send` 和 `view.setBounds`，对 iframe 就 `postMessage`，或者直接调用任何负责定位那个画面的代码。

核心不依赖 Electron、任何浏览器壳、React 或布局库，只用到 `ResizeObserver`、`requestAnimationFrame` 和 `getBoundingClientRect`。React 支持放在单独的 `view-anchor/react` 入口里。

## 为热路径而写

几何更新在每次缩放时都会触发，跟随拖拽时更是每一帧都触发。这个库就是为这条路径写的，下面的数字是实测，不是推断：

- **同步发布。** 测量和发布在同一个 `ResizeObserver` 回调里完成。没有定时器，不多等一帧。
- **先去重，再分配。** 和上一次已接受的矩形完全相同的结果，只比较四个数字就会被丢弃，不会创建任何对象。
- **只在需要时逐帧跟随。** `followGeometry` 只在滚动、拖动分栏或显式调用 `pulse()` 时才开始按 `requestAnimationFrame` 轮询，矩形稳定后自动停止。空闲时开销为零，隐藏或无效目标最多跟 30 帧。
- **generation 切换是 O(1)。** 协议层里，把某个锚点换到新的 generation 或清除它，不会碰到其他锚点。
- **合并批量，只发最新。** 同一个任务里排队的消息在一个微任务里合并，每个锚点只发送最新的几何数据。
- **体积小，可摇树。** 每个函数都是独立导出，并声明了 `sideEffects: false`。只用 `createViewAnchor` 的话，你只为 gzip 后 528 字节买单。

以下数字来自 `pnpm benchmark`，环境是 Node.js 24、Apple M4，取三个全新进程的中位数：

| 操作 | 数据量 | 耗时 |
| --- | ---: | ---: |
| `measurePlacement` | 1,000,000 次 | 8.9 ms |
| 发布一条 placement 消息 | 1,000,000 次 | 7.3 ms |
| 解码合法 batch | 100,000 条 | 3.1 ms |
| 所有锚点切换到新 generation | 10,000 个锚点 | 1.7 ms |
| 已有 100,000 个锚点时只 flush 一条 | 1 条 | 0.008 ms |

| 入口 | gzip 后 |
| --- | ---: |
| `view-anchor`（全部） | 2.6 KB |
| 单独 `createViewAnchor` | 528 B |
| `view-anchor/protocol` | 1.4 KB |
| `view-anchor/react` | 2.0 KB |

这些是同一台机器上的 Node.js 微基准，不包含 DOM layout、Electron IPC 和 structured clone，这几项请在你自己的应用里测。方法、内存数据和 V8 trace 见 [docs/performance-report.md](./docs/performance-report.md)。

## 安装

```bash
pnpm add view-anchor
# 或
npm install view-anchor
```

React 是可选的 peer dependency。Hook 从 `view-anchor/react` 导入。为了兼容 `v0.1.2`，根入口也会重新导出 `useViewAnchor`，所以只要导入了 `view-anchor` 就需要装 React。`view-anchor/protocol` 不需要。

## 用法

### 跟随一个 DOM 元素

```ts
import { createViewAnchor } from 'view-anchor'

const handle = createViewAnchor(target, {
  present: true,                 // 挂载原生视图
  publish: (bounds) => { ... },  // 收到实时矩形；接 IPC → setBounds
})

handle.update({ present, publish }) // 应用新选项并立刻发布一次
handle.dispose()                    // 停止观察；之后不会再发布
```

把 `present` 设为 `false` 可以收起视图。核心会发布一个零矩形并停止观察。宿主可以把子视图摘下来但保留 `WebContents`，这样之后再显示时是即时的。

### React

```tsx
import { useViewAnchor } from 'view-anchor/react'

function DebugPanel({ visible }: { visible: boolean }) {
  const ref = useViewAnchor({
    present: visible,
    publish: publishPanelBounds,
  })
  // 原生视图跟随这个占位 div。隐藏面板（visible=false 或卸载）
  // 只会收起视图，不会销毁它。
  return <div ref={ref} className="h-full w-full" />
}
```

Hook 在 React 18 和 19 的 StrictMode 双重挂载下不会发出过期的帧。

### 显式可见性

零矩形分不清"视图被隐藏了"和"视图可见但此刻正好是 0×0"。需要区分这两种情况时，用 `Placement` API。它发布的是 `{ visible: true, bounds }` 或 `{ visible: false }`，并提供可选的滚动跟随和几何跟随：

```ts
import { createPlacementAnchor } from 'view-anchor'

const handle = createPlacementAnchor(target, {
  publish: (placement) => { ... },
  followScroll: true,     // 任意祖先滚动时重新测量
  followGeometry: true,   // 滚动 / 拖拽期间逐帧轮询，稳定后停止
  guardDisplayNone: true, // 零面积或 display:none 的目标 → { visible: false }
})

handle.pulse() // 打开一小段逐帧跟随窗口，比如 CSS 过渡期间
```

React 版本是 `view-anchor/react` 里的 `usePlacementAnchor`。

### 由内容决定尺寸

有时被嵌入的那个画面的尺寸应该由它自己的内容决定，比如一条由下游代码渲染的工具栏。这种情况在被嵌入的文档里运行 `createSizeAdvertiser`，它把内容尺寸报告回去，宿主里的 DOM 占位元素就能跟着长到一样大：

```ts
import { createSizeAdvertiser } from 'view-anchor'

const handle = createSizeAdvertiser(contentWrapper, {
  axis: 'block',                 // 一个 advertiser 只管一个轴：block = 高度，inline = 宽度
  publish: (size) => { ... },    // 收到 { axis, extent }；接 IPC → 宿主
})

handle.update(publish) // 换一个发布通道，并立刻再报告一次当前尺寸
handle.dispose()       // 停止观察；之后不会再报告
```

> **注意：** 目标元素在它负责的那个轴上必须是随内容收缩的。如果这个尺寸反过来由宿主设置，两边会互相触发、永远停不下来。见 [docs/bidirectional-design.md](./docs/bidirectional-design.md)。

### 跨边界的带版本传输

核心交给你的是普通的 `Bounds`、`Placement` 和 `AdvertisedSize` 值。这些值一旦通过 IPC 或 `postMessage` 跨过进程或源的边界，通常就需要校验和排序。可选的 `view-anchor/protocol` 入口提供带版本的消息信封、对不可信输入的有界解码、按锚点丢弃过期消息的序列守卫，以及一个微任务批处理器：

```ts
import {
  createGeometryBatcher,
  createPlacementMessagePublisher,
  decodeGeometryWireValue,
} from 'view-anchor/protocol'

// 发送方（渲染进程、iframe 等）
const batcher = createGeometryBatcher((batch) => ipc.send('geometry', batch))
const publish = createPlacementMessagePublisher(
  { anchorId: 'editor', generation: 3 },
  batcher.publish,
)

// 接收方（主进程、宿主页面等）
const decoded = decodeGeometryWireValue(received, { maxMessages: 100 })
if (decoded.ok) { /* 先校验发送方，再只应用更新的消息 */ }
```

两条规则保证顺序正确：

- **每个 `{ anchorId, generation }` 只保留一个 publisher。** batcher 和 `createGeometrySequenceGuard` 会记住每个锚点见过的最大序号。针对同一地址重建 publisher 会让序号从 1 重新开始，它发的消息会被当成过期而丢弃。在 React 里用 `useMemo` 或 `useRef` 持有它。确实需要重新开始时，把 `generation` 加一。
- **同步 publisher 返回 `false` 表示"未接受"。** 核心会在下一次触发时重试同一份几何数据。批处理 publisher 入队后就返回 `true`，之后的重试由它自己负责。

完整约定见 [docs/protocol.md](./docs/protocol.md)。

## API

| 导出 | 类型 | 用途 |
|---|---|---|
| `createViewAnchor(target, opts)` | 函数 | 测量 DOM 元素并发布实时 bounds。零矩形表示已收起。 |
| `createPlacementAnchor(target, opts)` | 函数 | 同一个核心，带显式 `Placement` 可见性、可选的 `followScroll` / `followGeometry` / `guardDisplayNone`，以及 `pulse()`。 |
| `measurePlacement(target)` | 函数 | 纯测量：把目标矩形包成 `{ visible: true, bounds }`。 |
| `createSizeAdvertiser(target, opts)` | 函数 | 反向：把视图自身的内容尺寸报告给宿主。 |
| `useViewAnchor(opts)`，来自 `view-anchor/react` | Hook | 返回用于占位元素的 ref 回调。 |
| `usePlacementAnchor(opts)`，来自 `view-anchor/react` | Hook | `Placement` API 的 React 适配，包含 `followScroll` 和 `followGeometry`。 |
| `Bounds` | 类型 | CSS 像素单位的 `{ x, y, width, height }`。 |
| `Placement` | 类型 | `{ visible: true; bounds } \| { visible: false }`。 |
| `ViewAnchorOptions` / `ViewAnchorHandle` | 类型 | `createViewAnchor` 的选项和句柄。 |
| `PlacementAnchorOptions` / `PlacementAnchorHandle` | 类型 | `createPlacementAnchor` 的选项和句柄。 |
| `UseViewAnchorOptions` / `ViewAnchorRef`，来自 `view-anchor/react` | 类型 | `useViewAnchor` 的选项和 ref 形状。 |
| `UsePlacementAnchorOptions` / `PlacementAnchorRef`，来自 `view-anchor/react` | 类型 | `usePlacementAnchor` 的选项和 ref 形状。 |
| `AdvertisedAxis` / `AdvertisedSize` | 类型 | 反向方向的轴和负载类型。 |
| `SizeAdvertiserOptions` / `SizeAdvertiserHandle` | 类型 | `createSizeAdvertiser` 的选项和句柄。 |
| `view-anchor/protocol` | 函数 + 类型 | 带版本的消息、严格解码、序列守卫、消息 publisher 和微任务批处理。 |

## 文档

- [docs/mechanism.md](./docs/mechanism.md)：正向方向的原理。同步发布、防止过期帧、`present` / 零矩形 / 卸载的约定、StrictMode 下的行为。内含 [docs/index.html](./docs/index.html) 的 3D 交互演示。
- [docs/bidirectional-design.md](./docs/bidirectional-design.md)：两个方向同时运行时的设计。为什么正向是同步的而反向走动画帧、单轴归属，以及信任边界在哪。
- [docs/protocol.md](./docs/protocol.md)：消息信封、校验、排序、批处理，以及失败时会发生什么。
- [docs/performance-report.md](./docs/performance-report.md)：可复现的 CPU、堆、RSS、极端场景、V8 和导出体积测量。

## 参与贡献

欢迎提 issue 和 pull request。提交前请运行 `pnpm lint`、`pnpm check-types`、`pnpm test` 和 `pnpm build`。`pnpm benchmark` 会重新生成性能报告。

## 许可证

[MIT](./LICENSE) © lbb00
