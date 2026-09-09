# view-anchor

> 让主进程的原生视图（Electron `WebContentsView`）始终对齐某个 DOM 元素的几何位置的引擎无关原语。

[![npm version](https://img.shields.io/npm/v/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![npm downloads](https://img.shields.io/npm/dm/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![License](https://img.shields.io/npm/l/view-anchor)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)

[English](./README.md) · [简体中文](./README.zh-CN.md)

在 Electron 里，原生 `WebContentsView` 住主进程，你的布局在渲染进程。DOM 布局库（flexbox、dockview、react-resizable-panels……）只移动 DOM 节点，不知道这道进程边界的存在。`view-anchor` 就是跨过这道边界的桥：它测量目标元素的 `getBoundingClientRect()`，把矩形交给一个 `publish` 回调（由你接上 IPC → `setBounds`），并在元素位移或缩放时重新发布。

核心不依赖 React、Electron 或任何宿主布局引擎。涉及 React 的代码只在适配层。

## 特性

- **一对一绑定** —— 一个原生视图跟随一个 DOM 元素。`update()` 应用新选项并立即重新发布。
- **同步、去重的发布** —— 在同一个观察回调里测量并发布，原生视图不会比 DOM 多拖一帧（除不可避免的跨进程帧外）。与上次逐字段相同的矩形会被跳过。
- **收起而不销毁** —— `present: false` 发布零矩形并停止观察；宿主可以摘除子视图但保留 `WebContents` 存活。
- **显式可见性** —— `Placement` API 能区分「真正 0×0 但在屏」和「隐藏」的视图，而不是从尺寸推断可见性。
- **反向：内容尺寸回流** —— `createSizeAdvertiser` 把视图自身内容的尺寸回报给宿主，让 DOM 占位跟着内容长。
- **React 适配层** —— `useViewAnchor` hook，挂到一个占位元素上即可。
- **核心零依赖** —— 核心不 import React、Electron 或任何布局引擎。

## 安装

```bash
pnpm add view-anchor
# 或
npm install view-anchor
```

React 是可选 peer 依赖，只有用 `useViewAnchor` 适配层时才需要。

## 快速上手

### 命令式核心

```ts
import { createViewAnchor } from 'view-anchor'

const handle = createViewAnchor(target, {
  present: true,                 // 挂载原生视图
  publish: (bounds) => { ... },  // 接收实时矩形；由它负责 IPC → setBounds
})

handle.update({ present, publish }) // 应用新选项（会立即重新发布）
handle.dispose()                    // 停止观察；此后不再发布
```

### React

```tsx
import { useViewAnchor } from 'view-anchor'

function DebugPanel({ visible }: { visible: boolean }) {
  const ref = useViewAnchor({
    present: visible,
    publish: publishPanelBounds,
  })
  // 原生视图跟随这个占位 div。隐藏面板
  // （visible=false 或卸载）会让它收起，但不销毁。
  return <div ref={ref} className="h-full w-full" />
}
```

### 反向：内容尺寸上报

当一块 `WebContentsView` 的尺寸由它**自己的内容**主导时（例如交给下游控制的 toolbar），在**下游视图自己的渲染进程**里跑：

```ts
import { createSizeAdvertiser } from 'view-anchor'

const handle = createSizeAdvertiser(contentWrapper, {
  axis: 'block',                 // 这个 advertiser 只主导一条轴（block=高 / inline=宽）
  publish: (size) => { ... },    // 接收 { axis, extent }，由它负责 IPC → 宿主
})

handle.update(publish) // 换 publish（IPC 通道），并立即把当前尺寸发给它
handle.dispose()       // 停止观察；此后不再上报
```

> **注意 footgun**：`target` 必须在主导轴上 shrink-to-fit——如果它的尺寸由宿主灌入的视图尺寸反向决定，跨进程环不会收敛。详见 [docs/bidirectional-design.md](./docs/bidirectional-design.md)。

## API

| 导出 | 类型 | 作用 |
|---|---|---|
| `createViewAnchor(target, opts)` | 函数 | 正向命令式核心：测量并发布实时边界。零矩形表示收起。 |
| `createPlacementAnchor(target, opts)` | 函数 | 同款核心的显式 `Placement` 变体，另有 opt-in 的 `followScroll` / `followGeometry` / `guardDisplayNone` 与 `pulse()`。 |
| `measurePlacement(target)` | 函数 | 纯测量：把目标矩形包成 `{ visible: true, bounds }`。 |
| `useViewAnchor(opts)` | Hook | React 适配层，返回挂占位元素的 ref 回调。 |
| `createSizeAdvertiser(target, opts)` | 函数 | 反向核心：把视图自身内容尺寸回报给宿主。 |
| `Bounds` | 类型 | `{ x, y, width, height }`，单位 CSS 像素。 |
| `Placement` | 类型 | `{ visible: true; bounds } \| { visible: false }` —— 显式可见性。 |
| `ViewAnchorOptions` / `ViewAnchorHandle` | 类型 | 正向零矩形核心的选项与句柄形状。 |
| `PlacementAnchorOptions` / `PlacementAnchorHandle` | 类型 | `Placement` 核心的选项与句柄形状。 |
| `UseViewAnchorOptions` / `ViewAnchorRef` | 类型 | React 适配层的选项与 ref 形状。 |
| `AdvertisedAxis` / `AdvertisedSize` | 类型 | 反向的轴与帧载荷类型。 |
| `SizeAdvertiserOptions` / `SizeAdvertiserHandle` | 类型 | 反向核心的选项与句柄形状。 |

## 文档

- [docs/mechanism.mdx](./docs/mechanism.mdx) —— 正向机制的完整说明：同步发布与陈旧帧安全、`present` / 零矩形 / 卸载契约、React 18 StrictMode 行为。内含可交互 3D 演示 [docs/anchor-3d.html](./docs/anchor-3d.html)。
- [docs/bidirectional-design.md](./docs/bidirectional-design.md) —— 双向几何桥：同步 / RAF 的刻意不对称、单轴所有权与收敛性、信任边界。

## 贡献

欢迎提 issue 和 PR。提交前请在本地跑一遍：`pnpm lint`、`pnpm check-types`、`pnpm test`、`pnpm build`。

## License

[MIT](./LICENSE) © lbb00
