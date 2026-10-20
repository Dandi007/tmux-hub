# 初始连接发送队列与过期尺寸

## 1 第一性原理：要什么

用户在终端首次连接完成前输入的按键应在连接打开后按顺序送达一次，无需先断线重连。同一可见布局下首次重连不应重放旧尺寸、触发无意义的重绘并把已回底的位置恢复到旧历史。隐藏标签页仍不得 pin 会话。

## 2 现状与根因

RSI 第25轮真实 dogfood366b00c 的桌面首次重连发出旧182列 resize，随后发出当前203列 resize；约224ms后产生额外resync。在真实resync开始后回底并再次断线，3/3恢复到旧60行，2.1秒后仍未收敛。手机没有桌面pool的初始fit队列，3个对照正常。初始open不调用flushSendQueue，只有重连open会flush，所以连接前的旧resize残留到第一次重连。普通按键走相同队列，也需要初始open及时送达。

## 3 方案设计

```text
连接未OPEN：按键等保序排队；resize不入离线队列
初始OPEN：取消已销毁连接的工作 → flush普通队列 → heartbeat → 可见页延迟fit/pin
重连OPEN：保留既有flush与当前尺寸发布
```

resize是瞬时状态，不是必须逐个重放的输入事件；URL握手已携带尺寸，初始open后的现有fit发布和重连open后的现有尺寸发布会补上最新值。丢弃无法即时发送的resize，不使隐藏页面在稍后打开连接时重放曾经可见时的pin。普通输入队列保序、容量与既有重连行为不变。初始open先检查disposed，再flush普通消息。

保持真实resize的aligned resync，以及snapshotLocalLfb的弱网保护；不靠省略重绘、放宽滚动断言或加长旧测试等待来掩盖问题。

## 4 改动清单

| 文件 | 改动 |
| --- | --- |
| src/web/terminal.ts | 非OPEN的resize不排队；初始open冲刷输入队列并检查disposed |
| tests/e2e/key-conformance.e2e.ts | 握手前真实输入在首次连接上送达一次 |
| tests/e2e/fidelity-reconnect-queue.ts | 几何不变的首次重连及回底/再次断线保真回归 |
| tests/e2e/fidelity-suite.ts | 登记共享桌面/手机回归 |
| AGENTS.md | 登记本设计 |

## 5 测试与验收

先在旧代码上运行新增E2E，确认早期输入滞留；滚动竞态以第25轮已记录的真实复现为依据，新增回归继续验证回底行为，不声称它在每次本地运行都必然失败；通过真实本地hub、私有tmux socket和浏览器键盘/滚动操作断言pane及屏幕行为。必要的网络/事件控制只安排初始握手时机，不伪造产品队列或恢复状态。保留既有隐藏标签页、键盘顺序、普通resize、滚动重连与弱网回归。

清除继承hub环境后执行build、lint、全量unit/integration及desktop/emulator E2E，补emulator-mobile。按精确head/merge SHA分别验证PR和main push CI成功，再部署dogfood。复用第25轮同一回底/断线时序验证桌面与手机均不再恢复旧60行，另外检查初始排队输入一次送达；检查截图并清理专属会话。若CI因runner链路连续两次失败，按loop契约关闭PR并保留证据，不部署。

## 6 非目标

不改服务端协议、滚动快照算法、全局输入容量、语音、prod、harness或外部runner配置；本次只处理初始发送队列与过期resize重放。
