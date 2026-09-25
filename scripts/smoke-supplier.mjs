// 供应商结算与采购对账闭环 —— 逻辑冒烟测试
// 覆盖：验收差异（到货/合格/差异原因，差异不入库、消耗待收额度）、采购入完自动出供应商账单、
//       运营发起结算（settle:apply）/ 财务复核（settle:review）三权分立、驳回回退重新发起、
//       复核按「采购批次 + 售后补发」回写库存对账勾稽（不一致拦截）、快照留存、
//       P5 库存勾稽、看板/角标、租户隔离与审计留痕。
import { setActivePinia, createPinia } from 'pinia'
import { usePlatformStore } from '@/store/platform'

setActivePinia(createPinia())
const s = usePlatformStore()
s.init()
const today = s.todayDate

let failed = 0
const assert = (cond, msg) => {
  if (cond) console.log('  ✅', msg)
  else { console.error('  ❌', msg); failed++ }
}
const g5 = () => s.goods.find((g) => g.id === 'g5')
const g6 = () => s.goods.find((g) => g.id === 'g6')

console.log('— 种子：保温杯账单已结算闭环 + 盲盒账单（含 2 件破损差异）待结算 —')
const sb1 = s.supplierBills.find((b) => b.id === 'seed-sb1')
const sb2 = s.supplierBills.find((b) => b.id === 'seed-sb2')
const so1 = s.settleOrders.find((o) => o.id === 'seed-so1')
assert(sb1 && sb1.status === 'settled' && sb1.qty === 50 && sb1.amount === 2250 && sb1.settleId === 'seed-so1',
  '保温杯账单：已结算 2250 元（50 × 45），关联结算单')
assert(sb2 && sb2.status === 'unsettled' && sb2.qty === 28 && sb2.diffQty === 2 &&
  sb2.grossAmount === 1140 && sb2.diffAmount === 76 && sb2.amount === 1064,
  '盲盒账单：待结算，到货 30 件 1140 元 − 差异 2 件扣款 76 元 = 应付 1064 元')
assert(so1 && so1.status === 'settled' && so1.reconSnapshot?.batchQty === 50 && so1.reconSnapshot?.balanced,
  '种子结算单：已复核，留存库存对账回写快照（2 批 50 件勾稽一致）')
const pb5 = s.inboundBatches.find((b) => b.id === 'seed-pb5')
assert(pb5 && pb5.arrivedQty === 18 && pb5.qty === 16 && pb5.diffQty === 2 && pb5.diffReason === 'damage',
  '验收批次留痕：次批到货 18、合格 16、运输破损差异 2')
assert(s.dashboard.billUnsettled === 1 && s.dashboard.settleDone === 1 && s.dashboard.settleAmount === 2250 &&
  s.dashboard.acceptDiffQty === 2, '看板：待结算 1 / 已结算 1 / 累计 2250 元 / 差异 2 件')
assert(s.pendingSettleCount === 0, '消费者视角结算角标不提示')

console.log('— RBAC：运营发起 / 财务复核，两权分立 —')
s.loginAsCustomer()
assert(s.createSettleOrder(sb2.id, {}) === null, '消费者发起结算被拦截')
s.loginAsMember('m-star-ops')
assert(s.can('settle:apply') && !s.can('settle:review'), '活动运营：仅结算发起权限')
assert(s.reviewSettleOrder(so1.id, true) === false, '运营无复核权限，复核被拦截')
s.loginAsMember('m-star-fin')
assert(s.can('settle:review') && !s.can('settle:apply'), '财务对账：仅结算复核权限')
assert(s.createSettleOrder(sb2.id, {}) === null, '财务无发起权限，发起被拦截')
s.loginAsMember('m-star-ship')
assert(!s.can('settle:apply') && !s.can('settle:review'), '物流客服：结算两权均无')

console.log('— 验收差异：到货 8 / 合格 6 / 质检不合格 2，差异不入库、消耗待收额度 —')
s.loginAsMember('m-star-ops')
const po = s.createPurchaseOrder({ targetType: 'goods', targetId: 'g5', qty: 8, unitPrice: 60, supplier: '午餐供应方', reason: '高价值权益补货' })
assert(!!po && po.unitPrice === 60 && po.supplier === '午餐供应方', '采购单带预估单价与供应商')
s.loginAsMember('m-star-fin')
assert(s.reviewPurchaseOrder(po.id, true, '同意') === true, '采购审批通过')
s.loginAsMember('m-star-ship')
const g5Before = g5().remain
assert(s.inboundPurchase(po.id, { qty: 0 }) === null, '合格数量需为正整数')
assert(s.inboundPurchase(po.id, { qty: 9 }) === null, '到货超待收额度被拦截（待收 8）')
assert(s.inboundPurchase(po.id, { qty: 3, arrivedQty: 2 }) === null, '到货数少于合格数被拦截')
const b1 = s.inboundPurchase(po.id, { qty: 5, arrivedQty: 5, carrier: '午餐供应方' })
assert(!!b1 && b1.diffQty === 0 && g5().remain === g5Before + 5, '首批到货 5 全部合格入库')
assert(s.inboundPurchase(po.id, { qty: 4 }) === null, '剩余待收 3，到货 4 被拦截')
const b2 = s.inboundPurchase(po.id, { qty: 1, arrivedQty: 3, diffReason: 'reject', carrier: '午餐供应方', note: '2 件质检不合格拒收' })
assert(!!b2 && b2.diffQty === 2 && b2.diffReason === 'reject', '次批到货 3：合格 1、质检不合格差异 2')
assert(po.status === 'received' && po.inboundQty === 6 && po.diffQty === 2, '合格 6 + 差异 2 = 采购 8 → 入库完成')
assert(g5().remain === g5Before + 6 && g5().stock === g5Before + 6, '库存仅按合格数抬升（差异 2 件不入库）')
const billG5 = s.supplierBills.find((b) => b.poId === po.id)
assert(!!billG5 && billG5.status === 'unsettled' && billG5.qty === 6 && billG5.diffQty === 2 &&
  billG5.amount === 360 && billG5.diffAmount === 120 && billG5.grossAmount === 480,
  `入完自动出账：合格 6 × 60 = 360 元（差异 2 件扣款 120 元，到货 8 件 480 元）`)
assert(s.inboundBatches.filter((b) => b.poId === po.id).length === 2, '两批验收均写入 append-only 台账')

console.log('— 结算闭环：运营发起 → 财务驳回回退 → 重新发起 → 复核通过（对账回写） —')
s.loginAsMember('m-star-ops')
const soA = s.createSettleOrder(sb2.id, { note: '月结批次 W4' })
assert(!!soA && soA.status === 'pending' && soA.amount === 1064 && soA.diffQty === 2, '运营按盲盒账单发起结算单（待复核）')
assert(sb2.status === 'settling' && sb2.settleId === soA.id, '账单转「结算中」并回指结算单')
assert(s.createSettleOrder(sb2.id, {}) === null, '结算中账单重复发起被拦截')
s.loginAsMember('m-star-fin')
assert(s.reviewSettleOrder(soA.id, false, '差异件照片待补传') === true, '财务驳回结算单')
assert(soA.status === 'rejected' && sb2.status === 'unsettled' && sb2.settleId === '', '驳回后账单回退「待结算」')
s.loginAsMember('m-star-ops')
const soB = s.createSettleOrder(sb2.id, { note: '差异照片已补传，重新发起' })
assert(!!soB && soB.id !== soA.id && sb2.status === 'settling', '驳回后可重新发起结算（新结算单）')
s.loginAsMember('m-star-fin')
assert(s.reviewSettleOrder(soB.id, true, '批次勾稽一致，同意付款') === true, '财务复核通过')
assert(soB.status === 'settled' && sb2.status === 'settled', '结算单/账单双落「已结算」')
const snap = soB.reconSnapshot
assert(!!snap && snap.balanced && snap.batchCount === 2 && snap.batchQty === 28 && snap.batchDiff === 2 &&
  snap.stockRemain === 57 && snap.stockTotal === 58 && !snap.afterSale,
  '对账回写快照：2 批合格 28 + 差异 2 勾稽一致，账面 remain 57（含风控预占 1）/stock 58')
assert(s.reviewSettleOrder(soB.id, true) === false, '已结算单重复复核被状态机拦截')
assert(s.createSettleOrder(sb2.id, {}) === null, '已结算账单不可再发起')

console.log('— 关联售后补发：补发未履约时结算拦截，履约后勾稽通过 —')
// 公仔采购 seed-po2（关联 waiting_stock 售后 seed-as3）入完 → 自动出账
s.loginAsMember('m-star-ship')
assert(s.inboundPurchase('seed-po2', { qty: 4, carrier: '潮玩供应仓' }) !== null, '公仔采购剩余 4 件验收入库')
const po2 = s.purchaseOrders.find((o) => o.id === 'seed-po2')
assert(po2.status === 'received' && po2.inboundQty === 10, '公仔采购入满完结')
const billG6 = s.supplierBills.find((b) => b.poId === 'seed-po2')
assert(!!billG6 && billG6.qty === 10 && billG6.amount === 890 && billG6.afterSaleId === 'seed-as3',
  '公仔账单自动生成（10 × 89 = 890 元，关联售后补发单）')
s.loginAsMember('m-star-ops')
const soG6 = s.createSettleOrder(billG6.id, {})
assert(!!soG6 && soG6.afterSaleId === 'seed-as3', '按公仔账单发起结算单（关联售后补发）')
s.loginAsMember('m-star-fin')
assert(s.reviewSettleOrder(soG6.id, true) === false, '关联补发售后仍挂起待补货：复核被对账勾稽拦截')
assert(soG6.status === 'pending' && billG6.status === 'settling', '拦截不落账：结算单仍待复核')
assert(s.auditLogs.some((l) => l.action === 'settle-recon' && l.result === 'denied' && l.orderId === soG6.id),
  '勾稽拦截写 denied 审计（settle-recon）')
// 管理员从待处理售后继续补发履约
s.loginAsMember('m-star-admin')
const g6BeforeResume = g6().remain
assert(s.reviewAfterSale('seed-as3', true, '采购入库完成，继续补发履约') === true, '待补货售后继续履约')
assert(g6().remain === g6BeforeResume - 1, '补发履约扣减库存 1 件')
s.loginAsMember('m-star-fin')
assert(s.reviewSettleOrder(soG6.id, true, '补发已履约，同意结算') === true, '补发履约后复核通过')
assert(soG6.status === 'settled' && soG6.reconSnapshot.afterSale?.done === true &&
  soG6.reconSnapshot.afterSale?.consumed === 1 && !!soG6.reconSnapshot.afterSale?.reshipmentId,
  '对账回写快照含售后补发履约（已补发 1 件 + 补发发货单）')
assert(soG6.reconSnapshot.stockRemain === g6().remain && soG6.reconSnapshot.stockTotal === g6().stock,
  '快照记录当前库存账面')

console.log('— 第二笔差异账单结算 + 累计金额 —')
s.loginAsMember('m-star-ops')
const soG5 = s.createSettleOrder(billG5.id, {})
assert(!!soG5, '按质检差异账单发起结算')
s.loginAsMember('m-star-fin')
assert(s.reviewSettleOrder(soG5.id, true) === true && soG5.reconSnapshot.batchDiff === 2, '复核通过（差异 2 件勾稽）')
assert(s.dashboard.settleDone === 4 && s.dashboard.billUnsettled === 0 && s.dashboard.settlePending === 0,
  '看板：已结算 4 单，待结算/待复核清零')
assert(s.dashboard.settleAmount === 2250 + 1064 + 890 + 360, `累计结算金额 4564 元（实际 ${s.dashboard.settleAmount}）`)
assert(s.dashboard.acceptDiffQty === 4, '累计验收差异 4 件（盲盒 2 + 午餐 2）')
assert(s.pendingSettleCount === 0, '结算角标清零')

console.log('— P5 库存对账：采购批次（含差异）与售后补发口径平账 —')
s.runRecon(today, true)
const bill = s.reconBillOf(today)
const g4Row = bill.diffs.stock.find((x) => x.targetId === 'g4')
assert(g4Row && g4Row.purchased === 28 && g4Row.diff === 0, '盲盒 P5：采购入库按合格 28 件勾稽，账实相符')
const g5Row = bill.diffs.stock.find((x) => x.targetId === 'g5')
assert(g5Row && g5Row.purchased === 6 && g5Row.diff === 0, '午餐 P5：合格 6 件勾稽（差异 2 件不入账），账实相符')
const g6Row = bill.diffs.stock.find((x) => x.targetId === 'g6')
assert(g6Row && g6Row.purchased === 10 && g6Row.diff === 0, '公仔 P5：采购 10 件 + 补发消耗 1 件勾稽，账实相符')
assert(bill.diffs.stock.filter((x) => x.diff !== 0).length === 0, '今日 P5 全部账实相符')
assert(s.stockAdjustments.filter((x) => x.tenantId === 't-star').length === 0, '验收差异不产生库存调整凭证（结算扣款口径）')

console.log('— 审计留痕：供应商结算全链路动作齐全、归类 settle 模块 —')
;['supplier-bill', 'settle-apply', 'settle-reject', 'settle-review', 'settle-recon'].forEach((a) => {
  assert(s.auditLogs.some((l) => l.action === a && l.tenantId === 't-star'), `审计包含「${a}」`)
})
const settleLogs = s.auditLogs.filter((l) => ['supplier-bill', 'settle-apply', 'settle-review', 'settle-reject'].includes(l.action))
assert(settleLogs.every((l) => l.module === 'settle'), '结算动作全部归类「供应商结算」模块')
assert(s.auditLogs.some((l) => l.action === 'settle-recon' && l.result !== 'denied' && l.detail.includes('勾稽一致')),
  '对账回写审计含勾稽一致明细')
assert(s.auditLogs.some((l) => l.action === 'supplier-bill' && l.detail.includes('扣款 76.00')),
  '账单生成审计含差异扣款金额')

console.log('— 租户隔离：云雀数科无星河账单/结算单；员工不可跨租户 —')
s.loginAsMember('m-platform')
s.switchTenant('t-cloud')
assert(s.scopedSupplierBills.length === 0 && s.scopedSettleOrders.length === 0, '云雀账单/结算单列表为空（强隔离）')
s.switchTenant('t-star')
s.loginAsMember('m-star-fin')
assert(s.switchTenant('t-cloud') === false, '星河财务不能切入云雀租户')
assert(s.activeTenantId === 't-star' && s.scopedSettleOrders.length >= 4, '星河上下文结算单完整可见')

console.log(failed ? `\n共 ${failed} 项失败` : '\n全部通过 🎉')
process.exit(failed ? 1 : 0)
