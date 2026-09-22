// 交接单渲染：把节点快照映射为 reference 样例中的结构化字段。
// 交接单是只读视图，数据全部来自事件投影，不产生任何新记录。

export function renderHandoffSheet(state, snapshot, template) {
  const h = snapshot.handoff;
  const rows = Object.fromEntries(
    template.fields.map((f) => [f.key, undefined]),
  );
  rows.handoffNo = h ? `HD-${state.shipmentId}-${snapshot.node.nodeId}` : `HD-PENDING-${state.shipmentId}-${snapshot.node.nodeId}`;
  rows.shipmentId = state.shipmentId;
  rows.artifactName = state.artifact.name;
  rows.fragilityLevel = state.fragilityLevel;
  rows.nodeName = snapshot.node.name;
  rows.scheduledWindow = snapshot.node.windowLocal;
  rows.eventTime = h?.at ?? null;
  rows.sealId = state.sealId;
  rows.sealStatus = snapshot.boxCondition.sealStatus;
  rows.temperatureC = snapshot.boxCondition.temperatureC;
  rows.humidityPct = snapshot.boxCondition.humidityPct;
  rows.inspectionResults = snapshot.boxCondition.checklist.map((c) => ({
    itemId: c.itemId,
    label: c.label,
    status: c.result,
  }));
  rows.carrierName = h?.carrier.carrierName ?? null;
  rows.carrierId = h?.carrier.carrierId ?? null;
  rows.dualConfirmations = state.crateOpenings
    .filter((o) => o.nodeId === snapshot.node.nodeId)
    .flatMap((o) => o.confirmations.map((c) => ({ name: c.name, role: c.role, personId: c.personId, reason: o.reason })));
  rows.openAnomalies = snapshot.openAnomalies.map((a) => ({ anomalyId: a.anomalyId, type: a.type, description: a.description }));
  rows.evidence = snapshot.evidenceAtNode.map((e) => ({
    deviceSeq: e.deviceSeq,
    type: e.evidenceType,
    fileCount: e.fileCount,
    mergedUploads: e.mergedUploads,
    late: e.late,
    lastCapturedAt: e.lastCapturedAt,
  }));

  return {
    title: template.title,
    status: h ? (snapshot.frozen ? "已交接但链条冻结" : "已完成") : "待交接",
    frozen: snapshot.frozen,
    fields: template.fields.map((f) => ({ key: f.key, label: f.label, value: rows[f.key] ?? null })),
    nextActions: snapshot.nextActions,
    generatedAt: snapshot.asOf,
  };
}
