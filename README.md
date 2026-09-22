# 文物运输交接服务

面向文物外展运输链的交接协调服务：按器物脆弱等级生成包装检查项与路线节点，记录封签、箱内温湿度、承运人签名与异常处置，支持离线终端补交证据，并在异常发生后冻结后续放行。

需要 Node.js 22+。无外部数据库依赖，状态保存在只追加事件日志中。

## 运行

```bash
npm ci
npm start           # 默认 0.0.0.0:8000
npm test            # 19 个测试
docker compose up --build
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8000` / `0.0.0.0` | 监听地址 |
| `EVENT_LOG_PATH` | `.runtime/events.jsonl` | 只追加事件日志位置（必须在持久卷上） |
| `SHIPPING_DATA_PATH` | `reference/shipping-data.json` | 包装规范/车辆/路线数据 |

## 设计要点

- **事件溯源 + 只追加 JSONL 日志**：记录不可修改、不可删除。异常冻结是未解决异常的派生状态，只能通过追加 `anomaly.resolved` 解除，无法靠改旧记录解除。写入带 fsync，重启重放恢复全部状态（含冻结、证据合并、超时提醒去重）。
- **统一事件时间**：所有时间必须是带时区偏移的 ISO 8601；拒绝无时区的“墙上时间”，跨时区节点一律按纪元毫秒排序。离线补传使用证据的**实际采集时间**进入时间线，而服务端另记接收时间用于判定迟交。
- **封签唯一绑定一条运输链**：全局封签索引随日志重建，跨链复用返回 `SEAL_ALREADY_BOUND`。
- **证据按设备序号合并**：同一 `deviceSeq` 的多次上传（含离线重传）合并为一条证据记录、文件按 sha256/文件名去重；证据事件**从不参与节点时间窗计算**。
- **超时提醒幂等**：每节点确定性 eventId，重启后立即补扫停机期间到期的窗口，且永不重复触发。
- **双人确认**：换车、拆箱必须两名不同的、具备授权角色（管理员/保护人员/押运员）的人确认。
- **节点快照**：任一节点可查询当时的箱况、责任人、未解决异常与可执行的下一步，支持 `?asOf=` 历史时点。

## API

写操作需带身份头：`x-user-id`、`x-user-name`、`x-user-role`（中文值需百分号编码）。支持 `Idempotency-Key` 供离线终端安全重试。

| 方法 路径 | 说明 |
| --- | --- |
| `GET  /health` | 进程存活检查 |
| `GET  /reference/fragility[?level=L1]` | 脆弱等级与检查项规范 |
| `GET  /reference/vehicles` / `/reference/routes` | 车辆能力 / 路线时间窗 |
| `POST /shipments` | 创建运输链（校验车辆能力，绑定封签） |
| `GET  /shipments` / `/shipments/:id` | 列表 / 当前状态投影 |
| `POST /shipments/:id/arrivals` | 记录节点到达 |
| `POST /shipments/:id/handoffs` | 完成交接：封签、温湿度、检查项、承运人签名；异常自动留痕并冻结 |
| `POST /shipments/:id/anomalies` | 上报异常（冲击/离线/倾侧/温湿度/封签…），上报即冻结 |
| `POST /shipments/:id/resolve-anomaly` | 管理员/保护人员填写处置结论解除冻结 |
| `POST /shipments/:id/vehicle-changes` | 换车（双人确认 + 能力校验） |
| `POST /shipments/:id/crate-openings` | 拆箱（双人确认 + 原因） |
| `POST /shipments/:id/evidence` | 证据上传/离线补传（按 deviceSeq 合并） |
| `GET  /shipments/:id/timeline` | 统一事件时间排序的时间线 |
| `GET  /shipments/:id/nodes/:nodeId[?asOf=]` | 节点快照：箱况/责任人/异常/下一步 |
| `GET  /shipments/:id/handoff-sheet/:nodeId` | 按交接单样例渲染的结构化交接单 |
| `POST /admin/scan-overdue` | 手动触发一次超时扫描（后台每 30s 自动扫描） |

## 典型异常处置流（冲击传感器离线 + 照片缺失）

1. `POST /anomalies` 上报 → 链条冻结，下一站卸货窗口仍可登记**到达**，但**交接放行被拦截**（409 `FROZEN`）。
2. 离线终端恢复网络后 `POST /evidence` 补交传感器日志/照片（标 `late`，按设备序号合并）。
3. 保护人员 `POST /resolve-anomaly` 填写处置结论（可引用补交证据的设备序号）→ 冻结解除。
4. 放行交接；交接时封签断裂、检查项失败、温湿度超标或必检项缺失会再次自动生成异常并冻结。

参考数据（西安—柏林路线、含跨时区的法兰克福/柏林节点、车辆能力、交接单样例）见 `reference/shipping-data.json`。
