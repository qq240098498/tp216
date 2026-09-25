// 水库的水量与水位的口径都集中在这里
const store = require('./store');

function decimalsOf(settings) {
  const precision = Number(settings.levelPrecision) || 0.01;
  return Math.max(0, String(precision).split('.')[1] ? String(precision).split('.')[1].length : 0);
}

function curveOf(data, reservoirId) {
  return data.curves.find((c) => c.reservoirId === reservoirId) || null;
}

function sortedPoints(curve) {
  return (curve.points || []).slice().sort((a, b) => Number(a.level) - Number(b.level));
}

// 由水位查库容：在水位-库容曲线的分段之间线性插值
function capacityAt(curve, level, settings) {
  const points = sortedPoints(curve);
  const result = (value) => store.round(value, 4);
  const target = Number(level);
  if (!points.length) return 0;
  if (target <= Number(points[0].level)) return result(Number(points[0].capacity));
  if (target >= Number(points[points.length - 1].level)) return result(Number(points[points.length - 1].capacity));
  for (let i = 0; i < points.length - 1; i += 1) {
    const low = points[i];
    const high = points[i + 1];
    if (target >= Number(low.level) && target <= Number(high.level)) {
      const ratio = (target - Number(low.level)) / (Number(high.level) - Number(low.level));
      return result(Number(low.capacity) + ratio * (Number(high.capacity) - Number(low.capacity)));
    }
  }
  return result(Number(points[points.length - 1].capacity));
}

// 由库容反查水位：同样按曲线分段反解
function levelAt(curve, capacity) {
  const points = sortedPoints(curve);
  const digits = 2;
  const target = Number(capacity);
  if (!points.length) return 0;
  if (target <= Number(points[0].capacity)) return store.round(Number(points[0].level), digits);
  if (target >= Number(points[points.length - 1].capacity)) return store.round(Number(points[points.length - 1].level), digits);
  const first = points[0];
  const last = points[points.length - 1];
  const ratio = (target - Number(first.capacity)) / (Number(last.capacity) - Number(first.capacity));
  return store.round(Number(first.level) + ratio * (Number(last.level) - Number(first.level)), digits);
}

// 汛期判断与限水位
function inFloodSeason(dateStr, settings) {
  const parts = String(dateStr || '').split('-');
  if (parts.length !== 3) return false;
  const month = Number(parts[1]);
  const startMonth = Number(String(settings.floodSeasonStart).split('-')[0]);
  const endMonth = Number(String(settings.floodSeasonEnd).split('-')[0]);
  return month >= startMonth && month <= endMonth;
}

function limitLevelOf(reservoir, dateStr, settings) {
  return inFloodSeason(dateStr, settings) ? Number(reservoir.floodLimitLevel) : Number(reservoir.normalLevel);
}

function levelCheck(reservoir, level, dateStr, settings) {
  const limit = limitLevelOf(reservoir, dateStr, settings);
  const over = store.round(Number(level) - limit, 2);
  return { limit, level: Number(level), over, exceeded: over > 0, floodSeason: inFloodSeason(dateStr, settings) };
}

// 预警等级从低到高：正常 < 注意 < 警戒 < 严重
const GRADE_RANK = { 正常: 0, 注意: 1, 警戒: 2, 严重: 3 };

// 水位单输入定级：到汛限定严重，到警戒定警戒，警戒水位以下 0.5m 定注意
function warningByLevel(reservoir, level) {
  const value = Number(level);
  const floodLimit = Number(reservoir.floodLimitLevel);
  const warningLine = Number(reservoir.warningLevel);
  const attentionLine = store.round(warningLine - 0.5, 2);
  if (value >= floodLimit) return { grade: '严重', thresholdName: '汛限水位', threshold: floodLimit };
  if (value >= warningLine) return { grade: '警戒', thresholdName: '警戒水位', threshold: warningLine };
  if (value >= attentionLine) return { grade: '注意', thresholdName: '警戒水位以下0.5m', threshold: attentionLine };
  return { grade: '正常', thresholdName: '', threshold: null };
}

// 入库流量单输入定级：达到设置里的严重/注意门槛就提级（流量没有“警戒”档）
function warningByFlow(inflowFlow, settings) {
  const flow = Number(inflowFlow);
  const serious = Number(settings.inflowSeriousFlow);
  const attention = Number(settings.inflowAttentionFlow);
  if (Number.isFinite(flow) && flow >= serious) return { grade: '严重', thresholdName: '入库严重流量', threshold: serious };
  if (Number.isFinite(flow) && flow >= attention) return { grade: '注意', thresholdName: '入库注意流量', threshold: attention };
  return { grade: '正常', thresholdName: '', threshold: null };
}

// 预警等级：水位和入库流量两个输入分别定级，哪个先到门槛就按哪个（取高者）；
// 两边同级时同时记两个输入；并给出这次具体按哪个输入定的级
function warningOf(reservoir, level, inflowFlow, settings) {
  const value = Number(level);
  const flow = Number.isFinite(Number(inflowFlow)) ? Number(inflowFlow) : 0;
  const levelPart = warningByLevel(reservoir, value);
  const flowPart = warningByFlow(flow, settings);
  const levelRank = GRADE_RANK[levelPart.grade] || 0;
  const flowRank = GRADE_RANK[flowPart.grade] || 0;

  let grade;
  let decidedBy;
  if (flowRank > levelRank) {
    grade = flowPart.grade;
    decidedBy = 'flow';
  } else if (levelRank > flowRank) {
    grade = levelPart.grade;
    decidedBy = 'level';
  } else if (levelRank === 0) {
    grade = '正常';
    decidedBy = 'none';
  } else {
    grade = levelPart.grade;
    decidedBy = 'both';
  }

  let reason;
  if (decidedBy === 'flow') {
    reason = '按入库流量 ' + flow + ' m³/s 定为' + grade + '（' + flowPart.thresholdName + '门槛 ' + flowPart.threshold + '）；同期水位 ' + value + ' m 只到“' + levelPart.grade + '”';
  } else if (decidedBy === 'level') {
    reason = '按水位 ' + value + ' m 定为' + grade + '（' + levelPart.thresholdName + ' ' + levelPart.threshold + ' m）；同期入库流量 ' + flow + ' m³/s 只到“' + flowPart.grade + '”';
  } else if (decidedBy === 'both') {
    reason = '水位与入库流量同时达到“' + grade + '”：水位 ' + value + ' m（' + levelPart.thresholdName + ' ' + levelPart.threshold + ' m）、入库流量 ' + flow + ' m³/s（' + flowPart.thresholdName + '门槛 ' + flowPart.threshold + '）';
  } else {
    reason = '水位 ' + value + ' m 与入库流量 ' + flow + ' m³/s 均未到提级门槛';
  }

  return {
    level: grade,
    decidedBy,
    byLevel: levelPart.grade,
    byFlow: flowPart.grade,
    levelThreshold: levelPart.threshold,
    levelThresholdName: levelPart.thresholdName,
    flowThreshold: flowPart.threshold,
    flowThresholdName: flowPart.thresholdName,
    levelValue: value,
    inflowFlow: flow,
    reason,
  };
}

// 时段水量平衡：入库水量 - 出库水量 - 损失 = 蓄变
function balance(data, reservoirId, fromDate, toDate) {
  const settings = data.settings;
  const reservoir = data.reservoirs.find((r) => r.id === reservoirId);
  const curve = curveOf(data, reservoirId);
  if (!reservoir || !curve) return null;

  const from = data.levels
    .filter((l) => l.reservoirId === reservoirId && l.date >= fromDate && l.date <= toDate)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const days = store.daysBetween(fromDate, toDate);

  const inflowRows = data.inflows.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const releaseRows = data.releases.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const meanInflow = store.round(inflowRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, inflowRows.length), 3);
  const meanRelease = store.round(releaseRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, releaseRows.length), 3);

  const inflowVolume = store.round((meanInflow * days * 86400) / 10000, 3);
  const releaseVolume = store.round((meanRelease * days * 3600) / 10000, 3);
  const lossVolume = 0;
  const startLevel = from.length ? Number(from[0].level) : 0;
  const endLevel = from.length ? Number(from[from.length - 1].level) : 0;
  const startCapacity = curve ? capacityAt(curve, startLevel, settings) : 0;
  const endCapacity = curve ? capacityAt(curve, endLevel, settings) : 0;
  const deltaStorage = store.round(endCapacity - startCapacity, 3);
  const residual = store.round(inflowVolume - releaseVolume - lossVolume - deltaStorage, 3);
  const balanced = Math.abs(residual) < Number(settings.balanceToleranceWan);
  return {
    reservoirId,
    reservoirName: reservoir.name,
    fromDate,
    toDate,
    days,
    meanInflow,
    meanRelease,
    inflowVolume,
    releaseVolume,
    lossVolume,
    startLevel,
    endLevel,
    startCapacity,
    endCapacity,
    deltaStorage,
    residual,
    tolerance: Number(settings.balanceToleranceWan),
    balanced,
  };
}

module.exports = {
  decimalsOf,
  curveOf,
  sortedPoints,
  capacityAt,
  levelAt,
  inFloodSeason,
  limitLevelOf,
  levelCheck,
  warningOf,
  warningByLevel,
  warningByFlow,
  GRADE_RANK,
  balance,
};
