# view-anchor 性能报告

数据由 `pnpm benchmark` 生成（3 个独立 Node.js 进程，每个预热 2 次、采样 7 次）。环境：Node.js 24.18.0、macOS arm64、Apple M4。数字只适合在同一台机器上比较，不代表浏览器布局或数据传递的耗时。

## 结论

- 与 0.2.2 相比，除协议解码外，各场景的耗时和内存都在正常波动范围内。
- 协议解码变慢，每条消息约多 30 纳秒。原因是 1.0 会检查每个对象的原型，拒绝带自定义原型的输入（见 [protocol.md](./protocol.md)）。一帧只有几十条消息时，这点开销可以忽略。
- 根入口变小约四分之一。

## 导出体积

使用 Rolldown 打包、tree-shaking 和 minify，`react` 作为外部依赖。

| 入口 | raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| `view-anchor` | 4,728B | 1,967B | 1,759B |
| `view-anchor/protocol` | 3,851B | 1,507B | 1,355B |
| `view-anchor/react` | 5,117B | 2,089B | 1,884B |

`pnpm benchmark` 的输出包含各单独导出的体积、CPU 和内存明细。`pnpm benchmark:v8` 会额外输出 V8 的优化和反优化日志。
