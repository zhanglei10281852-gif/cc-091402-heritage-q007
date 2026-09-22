# 文物运输交接服务

面向文物借展运输（如西安库房 → 国际航段 → 海外展馆卸货平台）的交接协调服务。
依据器物脆弱等级生成包装检查项与路线节点，记录封签、箱内温湿度、承运人签名与异常处置，
支持离线终端稍后补交证据；异常一旦发生即冻结后续放行。

## 运行

需要 Node.js 22+。

```bash
npm ci
npm start                 # 默认 0.0.0.0:8000
DATA_DIR=/data npm start  # 事件日志目录，默认 ./.data
npm test                  # 16 项测试
docker compose up --build
```

## 核心规则

- **事件溯源、只追加**：每条运输链一个 JSONL 事件日志，事件含 SHA-256 哈希链；
  业务状态由重放得到，没有任何修改/删除旧记录的入口。篡改日志会在重放时被发现。
- **封签唯一流转**：封签全局唯一，只能绑定一条运输链；拆箱即作废，中途重封必须双人确认。
- **异常冻结**：传感器离线、照片缺失、温湿度越界、指示器触发、检查不合格、超出时间窗等
  在交接落账后自动开立异常；存在未解除异常时，后续交接与放行一律 423 冻结。
  冻结只能由授权角色追加“异常解除”事件解除，不能靠改旧记录解除。
- **离线补传**：按 `设备序号(deviceId) + 设备内序号(deviceSeq)` 幂等合并，重复补交不落账；
  证据按实际拍摄时刻进入统一时间线，**不重新计算交接时间窗**（窗口结论只在交接时判定一次）。
- **双人确认**：换车、拆箱、中途重封必须两个不同的授权账号（管理员/保护人员）共同签署。
- **跨时区**：所有时间必须是带时区的 ISO 8601；排序与窗口判定统一归一到 UTC，查询同时给出节点本地时间。
- **重启有效**：冻结状态由重放恢复；超时错过窗口/滞留提醒由扫描器追加 `overdue.marked` 事件，
  服务重启即重扫，提醒不丢失、不重复。

## 主要接口

写接口在请求体携带 `actor: {id, name, role}`，`只读访客` 一律 403。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/catalog` | 包装规范、车辆能力、路线模板、交接单样例 |
| GET | `/catalog/packing-checks?fragilityLevel=4` | 按脆弱等级取检查项/温湿度限值/必交照片 |
| POST | `/shipments` | 创建运输链（封签、脆弱等级、车辆、路线模板） |
| GET | `/shipments` | 运输链列表（含冻结标记） |
| GET | `/shipments/:id` | 全量投影：箱况、封签、异常、超时、各节点下一步 |
| GET | `/shipments/:id/nodes/:seq` | 单节点全景：当时箱况、责任人、未决异常、下一步 |
| GET | `/shipments/:id/timeline` | UTC 统一排序的跨时区事件时间线 |
| POST | `/shipments/:id/handoffs` | 记录节点交接（检查项、温湿度、照片、承运人签名） |
| POST | `/shipments/:id/releases` | 节点放行（冻结期返回 423） |
| POST | `/shipments/:id/evidence` | 离线补传证据（按设备序号去重） |
| POST | `/shipments/:id/anomalies` | 人工登记异常 |
| POST | `/shipments/:id/anomalies/resolve` | 处置并解除异常（证据类须先补证） |
| POST | `/shipments/:id/vehicle-change` | 换车（双人确认、车辆能力校验） |
| POST | `/shipments/:id/crate-open` | 拆箱（双人确认，封签作废） |
| POST | `/shipments/:id/seals` | 中途重封（双人确认） |
| GET | `/seals/:sealId` | 封签唯一流转链查询 |
| POST | `/admin/scan-overdue` | 手动触发超时扫描 |

详细字段见 `docs/api.md`，参考数据见 `reference/catalog.json`。
