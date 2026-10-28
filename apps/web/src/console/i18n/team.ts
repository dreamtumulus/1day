import type { DictPair } from "./index";

const en = {
  "team.name": "Organization (team)",
  "team.unnamed": "Unnamed organization",
  "team.unassigned": "Not assigned",
  "team.verifiedHint": "The organization UUID must match the authorized Claude organization. Its name and UUID are visible only to administrators.",
  "team.proxyOccupied": "{n}/3 occupied",
  "team.proxyCapacityHint": "Normally two bound accounts per proxy; a third is used only when normal capacity is exhausted. Reservations also occupy slots.",
  "team.history": "Assignment history",
  "team.historyEmpty": "No assignment events yet",
  "team.event": "Event",
  "team.reason": "Reason",
  "team.actor": "Operator",
};
const zh: typeof en = {
  "team.name": "所属组织（team）",
  "team.unnamed": "未命名组织",
  "team.unassigned": "未分配",
  "team.verifiedHint": "组织 UUID 必须与实际授权的 Claude 组织一致。组织名称和 UUID 仅管理员可见。",
  "team.proxyOccupied": "已占 {n}/3",
  "team.proxyCapacityHint": "每个代理默认绑定两个账号，常规容量不足时启用第三个。正在上号的预留名额也计入占用。",
  "team.history": "分配历史",
  "team.historyEmpty": "暂无分配记录",
  "team.event": "事件",
  "team.reason": "原因",
  "team.actor": "操作人",
};

export default { en, zh } satisfies DictPair;
