# 远程控制检查

手机收到 **Mac 的回应** 后才会显示已连接。用 `turnwire remote status --watch` 查看通道状态，~~保存配对就算在线~~。

## 连接步骤

1. 在 Mac 上选择连接方式。
2. 用手机打开配对链接。
   - 查看顶部的连接提示。
   - 确认最近一次检测时间。

> Mac 需要保持唤醒并联网。
>
> 切换网络后，等待重新确认连接。

- [x] 页面已打开
- [x] Mac 已回应
- [ ] 在另一台设备上验证

第一行（显式换行）  
第二行仍在同一段。

## TypeScript 示例

```ts
const tunnel = {
  provider: "localhost-run",
  endpoint: "https://example.invalid/a/very/long/path/that/must/stay/inside/the/code/scroll/region",
};

console.log("<script>this is literal code</script>", tunnel);
```

## 服务比较

| 服务 | 首次设置 | 手机端 | 链接 | 状态 | 延迟 |
| :--- | :--- | :--- | :--- | :---: | ---: |
| localhost.run | 无需注册 | 浏览器 | https://example.invalid/a/very/long/path/for/testing/line/wrapping | 已连接 | 439 ms |
| cpolar | Auth Token | 浏览器 | https://example.invalid/cpolar | 待配置 | — |
| 自托管 Relay | 配置服务器 | 浏览器 | https://example.invalid/relay | 离线 | — |

长路径：`/Users/demo/Projects/a-very-long-workspace-name/packages/shared-remote-control/connection/verification.ts`。

访问[示例说明](https://example.invalid/docs)，或者打开 https://example.invalid/docs/connection/verification/with-a-very-long-path 。

---

当前记录仅代表最近一次确认。[^connection]

[^connection]: 锁屏和切换网络后需要重新检测。
