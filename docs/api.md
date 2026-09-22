# 接口说明

所有时间字段必须是**带时区偏移**的 ISO 8601 字符串（如 `2026-09-23T09:00:00+08:00`）。
身份字段为不可变字符串；写接口的 `actor` 必须包含 `id` / `name` / `role`，
角色仅限 `管理员`、`保护人员`、`只读访客`（访客只读）。

错误响应：`{ "error": "<code>", "message": "...", "details"?: ... }`。
冻结错误码 `shipment_frozen` / `evidence_outstanding` 返回 HTTP 423。

## 1. 创建运输链 `POST /shipments`

```json
{
  "shipmentId": "S-001",
  "artifactId": "artifact-0001",
  "artifactName": "唐三彩骆驼载乐俑",
  "fragilityLevel": 4,
  "routeTemplateId": "xian-overseas-2026",
  "vehicleType": "恒温气垫车",
  "seals": ["SEAL-XA-0001"],
  "actor": { "id": "u-wang", "name": "王保护", "role": "保护人员" }
}
```

- `fragilityLevel` 1-4 决定包装检查项、温湿度限值、必交照片种类（见 `GET /catalog/packing-checks?fragilityLevel=`）。
- 车辆 `maxFragility` 必须覆盖器物等级，否则 422 `vehicle_capability_exceeded`。
- 封签全局唯一：已在其他运输链上流转的封签返回 409 `seal_already_circulating`。
- 不传 `routeTemplateId` 时可用 `nodes` 自定义路线，节点时间窗按 UTC 必须单调不倒置。

## 2. 节点交接 `POST /shipments/:id/handoffs`

```json
{
  "nodeSeq": 0,
  "formNo": "HF-000",
  "occurredAt": "2026-09-23T09:00:00+08:00",
  "location": "西安博物院库房装箱月台",
  "temperatureC": 20,
  "humidityRh": 50,
  "shockTriggered": false,
  "tiltTriggered": false,
  "sensorOffline": false,
  "checks": [ { "item": "外箱无破损、无变形、无受潮痕迹", "result": "pass" } ],
  "photos": [ { "kind": "封签照片", "ref": "p/seal/1" } ],
  "carrierSignature": { "name": "张承运", "staffNo": "YD-778", "org": "中外运西安分公司" },
  "offline": false,
  "actor": { "id": "u-wang", "name": "王保护", "role": "保护人员" }
}
```

- `checks` 必须与该等级检查项一一对应、逐项给 `pass`/`fail`，防止漏检漏填。
- 交接落账后自动判定：温湿度越界、冲击/倾斜指示器触发、传感器离线、检查不合格、
  必交照片缺失、超出节点时间窗；任一命中即开立异常并冻结整条链的后续放行。
- 同一节点重复交接返回 409 `handoff_exists`（旧记录不可改，遗漏走证据补传）。
- 必须严格按节点顺序：前序节点未放行时返回 409 `node_locked`。

## 3. 放行 `POST /shipments/:id/releases`

```json
{ "nodeSeq": 0, "occurredAt": "2026-09-23T09:30:00+08:00", "actor": { "id": "u-wang", "name": "王保护", "role": "保护人员" } }
```

存在未解除异常时返回 423 `shipment_frozen`，响应 `details.anomalyIds` 列出阻塞项。
末节点放行后运输链自动 `completed`。

## 4. 离线补传证据 `POST /shipments/:id/evidence`

```json
{
  "nodeSeq": 0,
  "deviceId": "HK-09",
  "deviceSeq": 1,
  "capturedAt": "2026-09-23T09:02:00+08:00",
  "photos": [ { "kind": "缓冲材料照片", "ref": "p/foam/late1" } ],
  "sensor": { "sensorOnline": true, "temperatureC": 20.4, "humidityRh": 51 },
  "note": "出港区隧道无网络，恢复后补交",
  "actor": { "id": "u-term", "name": "押运终端", "role": "保护人员" }
}
```

- 幂等键为 `deviceId + deviceSeq`；重复提交返回 `{ "deduped": true, "eventSeq": <原事件序号> }`，不重复落账。
- 证据按 `capturedAt`（实际采集时刻）进入时间线；**交接时间窗结论不因此重算**。
- 缺照片异常须收到含照片的补传、传感器离线异常须收到 `sensorOnline:true` 的补传后才允许解除。

## 5. 异常处置

- 人工登记：`POST /shipments/:id/anomalies`，字段 `nodeSeq`、`kind`、`severity`、`description`、`occurredAt`。
- 解除冻结：`POST /shipments/:id/anomalies/resolve`

```json
{ "anomalyId": "AN-S-001-001", "resolvedAt": "2026-09-23T12:10:00+08:00", "note": "补证齐全，排除运输风险", "actor": { "id": "u-li", "name": "李管理", "role": "管理员" } }
```

解除是**追加新事件**；已解除异常重复解除返回 409 `anomaly_closed`。

## 6. 换车 / 拆箱 / 重封（双人确认）

`POST /shipments/:id/vehicle-change`：

```json
{ "toVehicle": "温控航空ULD舱", "occurredAt": "2026-09-23T12:00:00+08:00",
  "confirmations": [ {"id":"u-wang","name":"王保护","role":"保护人员"}, {"id":"u-li","name":"李管理","role":"管理员"} ],
  "actor": {"id":"u-wang","name":"王保护","role":"保护人员"} }
```

- `confirmations` 必须恰好两人、账号不同、角色均为管理员/保护人员，否则 422。
- `crate-open` 双人确认后旧封签全部（或指定）作废；未双人重封前交接返回 409 `no_active_seal`。
- `seals` 中途重封必须带双人 `confirmations`；新封签同样不能流到其他运输链。

## 7. 查询

- `GET /shipments/:id/nodes/:seq`：节点状态、时间窗（UTC 与节点本地）、交接箱况
  （温湿度/指示器/检查项/照片/封签/承运人/记录人）、`openAnomalies`、`nextActions`。
- `GET /shipments/:id/timeline`：全部业务事件按 UTC 排序，每条附 `utcTime` 与节点 `localTime`。
- `GET /seals/:sealId`：封签状态与唯一链条上的每次在场交接。
- `POST /admin/scan-overdue`：立即扫描；错过节点窗口产生 `window_missed`，
  交接后超过 `dwellMinutes` 未放行产生 `release_overdue`，每节点每类只记一次。
