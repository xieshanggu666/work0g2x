<template>
  <div class="st-view">
    <!-- 顶部概览 + 角色切换 -->
    <div class="st-hero">
      <div class="hero-stats">
        <div class="hs-item">
          <span class="hs-num warn">{{ stats.billUnsettled }}</span>
          <span class="hs-lab">待结算账单</span>
        </div>
        <div class="hs-item">
          <span class="hs-num info">{{ stats.settlePending }}</span>
          <span class="hs-lab">待财务复核</span>
        </div>
        <div class="hs-item">
          <span class="hs-num ok">{{ stats.settleDone }}</span>
          <span class="hs-lab">已结算单</span>
        </div>
        <div class="hs-item">
          <span class="hs-num amount">¥{{ fmt(stats.settleAmount) }}</span>
          <span class="hs-lab">累计结算金额</span>
        </div>
        <div class="hs-item">
          <span class="hs-num bad">{{ stats.acceptDiffQty }}</span>
          <span class="hs-lab">累计验收差异件数</span>
        </div>
      </div>
      <div class="role-box">
        <span class="role-tip">当前视角</span>
        <div class="role-switch">
          <button :class="{ active: store.role === 'user' }" @click="store.setRole('user')">👤 用户（只读）</button>
          <button :class="{ active: store.role === 'operator' }" @click="store.setRole('operator')">💰 运营（结算）</button>
        </div>
      </div>
    </div>

    <p class="loop-hint">
      闭环链路：采购分批验收入库（登记到货/合格/差异）→ 入完自动生成<b>供应商账单</b>（合格件 × 单价 − 验收差异扣款）
      → 活动运营核对账单<b>发起结算单</b> → 财务<b>复核</b>时按「采购验收批次 + 关联售后补发」回写库存对账勾稽，
      一致才落「已结算」；驳回回退待结算可重新发起。账单与结算单 append-only，全程审计留痕。
    </p>

    <!-- 供应商账单 -->
    <div class="card">
      <div class="card-title">
        🧾 供应商账单（{{ store.activeTenant.shortName }}）
        <div class="filters">
          <button v-for="f in billFilters" :key="f.key"
                  :class="{ active: billFilter === f.key }" @click="billFilter = f.key">
            {{ f.label }}<em v-if="f.key !== 'all'">（{{ billCountOf(f.key) }}）</em>
          </button>
        </div>
      </div>
      <p class="op-hint">
        采购单全部验收入库即自动出账：应付 = 合格入库件数 × 采购单价；验收差异（破损/短缺/质检不合格）件数不入库、按单价扣款。
      </p>

      <div v-if="visibleBills.length === 0" class="empty">暂无相关供应商账单（采购单入完自动出账）</div>

      <div v-for="b in visibleBills" :key="b.id" class="bill" :class="b.status">
        <div class="b-head">
          <span class="b-icon">{{ b.icon }}</span>
          <div class="b-main">
            <div class="b-title">
              {{ b.targetName }}
              <span class="b-src">{{ b.supplier }} · 采购 {{ b.poNo }}</span>
              <span v-if="b.afterSaleId" class="b-src shortage">🔗 售后补发 {{ b.afterSaleId }}</span>
            </div>
            <div class="b-sub">账单 {{ b.billNo }}（{{ b.id }}）· {{ b.createdAt }} {{ b.time }} 出账</div>
          </div>
          <span class="b-status" :class="b.status">{{ billMeta(b.status).label }}</span>
        </div>

        <div class="b-amounts">
          <div class="ba-item">
            <span class="ba-num">{{ b.qty }} 件</span>
            <span class="ba-lab">合格入库 × ¥{{ fmt(b.unitPrice) }}</span>
          </div>
          <div v-if="b.diffQty > 0" class="ba-item diff">
            <span class="ba-num">-{{ b.diffQty }} 件</span>
            <span class="ba-lab">验收差异扣款 ¥{{ fmt(b.diffAmount) }}</span>
          </div>
          <div class="ba-item total">
            <span class="ba-num">¥{{ fmt(b.amount) }}</span>
            <span class="ba-lab">应付金额（到货 {{ b.qty + b.diffQty }} 件 ¥{{ fmt(b.grossAmount) }}）</span>
          </div>
        </div>

        <!-- 待结算：运营发起结算（settle:apply） -->
        <div v-if="b.status === 'unsettled'" class="b-actions">
          <template v-if="store.isOperator && store.can('settle:apply') && store.identityKind !== 'platform'">
            <input v-model="noteOf(b).note" placeholder="结算备注（可选，如：月结批次 09 月第 4 周）" />
            <button class="btn-apply" @click="applySettle(b)">💰 发起结算单</button>
          </template>
          <span v-else-if="store.isOperator" class="waiting">🔒 平台超管不直接处理租户结算；当前角色无「供应商结算发起」权限时仅可查看</span>
          <span v-else class="waiting">等待运营核对账单并发起结算…</span>
        </div>
        <div v-else-if="b.status === 'settling'" class="b-linked">
          ⏳ 已关联结算单 {{ settleOf(b)?.settleNo || b.settleId }}，待财务复核
        </div>
        <div v-else class="b-linked ok">
          ✅ 已结算：结算单 {{ settleOf(b)?.settleNo || b.settleId }} · {{ settleOf(b)?.reviewedAt }} · 复核人 {{ settleOf(b)?.reviewer }}
        </div>
      </div>
    </div>

    <!-- 结算单 -->
    <div class="card">
      <div class="card-title">
        💰 供应商结算单（{{ store.activeTenant.shortName }}）
        <div class="filters">
          <button v-for="f in settleFilters" :key="f.key"
                  :class="{ active: settleFilter === f.key }" @click="settleFilter = f.key">
            {{ f.label }}<em v-if="f.key !== 'all'">（{{ settleCountOf(f.key) }}）</em>
          </button>
        </div>
      </div>
      <p class="op-hint">
        财务复核通过前自动回写库存对账：按采购验收批次逐笔勾稽合格/差异件数与账单金额，关联售后补发核对履约消耗；
        勾稽不一致整体拦截不落账，通过后勾稽快照随结算单留存。
      </p>

      <div v-if="visibleSettles.length === 0" class="empty">暂无相关结算单</div>

      <div v-for="o in visibleSettles" :key="o.id" class="settle" :class="o.status">
        <div class="s-head">
          <span class="s-icon">{{ o.icon }}</span>
          <div class="s-main">
            <div class="s-title">
              结算单 {{ o.settleNo }}
              <span class="s-src">{{ o.supplier }} · 账单 {{ o.billNo }} · 采购 {{ o.poNo }}</span>
            </div>
            <div class="s-sub">{{ o.targetName }} · 申请人 {{ o.applicant }} · {{ o.createdAt }} {{ o.time }}</div>
          </div>
          <div class="s-amount">
            <b>¥{{ fmt(o.amount) }}</b>
            <span v-if="o.diffQty > 0" class="s-diff">差异 {{ o.diffQty }} 件已扣 ¥{{ fmt(o.diffAmount) }}</span>
          </div>
          <span class="s-status" :class="o.status">{{ settleMeta(o.status).label }}</span>
        </div>

        <div class="s-body">
          <div class="s-line">计费：合格 {{ o.qty }} 件 × ¥{{ fmt(o.unitPrice) }} = ¥{{ fmt(o.amount) }}
            <template v-if="o.diffQty > 0">（到货 {{ o.qty + o.diffQty }} 件 ¥{{ fmt(o.grossAmount) }} − 差异扣款 ¥{{ fmt(o.diffAmount) }}）</template>
          </div>
          <div v-if="o.applyNote" class="s-line muted">申请备注：{{ o.applyNote }}</div>
          <div v-if="o.afterSaleId" class="s-line shortage">🔗 关联售后补发 {{ o.afterSaleId }}（结算复核时核对补发履约与库存消耗）</div>
        </div>

        <!-- 待复核：财务复核（settle:review） -->
        <div v-if="o.status === 'pending'" class="s-actions">
          <template v-if="store.isOperator && store.can('settle:review') && store.identityKind !== 'platform'">
            <input v-model="reviewNoteOf(o).note" placeholder="复核备注（可选）" />
            <button class="btn-approve" @click="review(o, true)">✅ 复核通过（回写库存对账）</button>
            <button class="btn-reject" @click="review(o, false)">🚫 驳回</button>
          </template>
          <span v-else-if="store.isOperator" class="waiting">🔒 平台超管不直接处理租户结算；当前角色无「供应商结算复核」权限时仅可查看</span>
          <span v-else class="waiting">等待财务复核…</span>
        </div>

        <div v-else-if="o.status === 'rejected'" class="s-review rejected">
          🚫 {{ o.reviewedAt }} · 复核人 {{ o.reviewer }} 驳回{{ o.reviewNote ? `：${o.reviewNote}` : '' }}；账单已回退待结算
        </div>

        <!-- 已结算：库存对账回写快照 -->
        <div v-else-if="o.reconSnapshot" class="s-recon">
          <div class="sr-title">
            🧮 库存对账回写快照 · {{ o.reconSnapshot.reconAt }} · 勾稽人 {{ o.reconSnapshot.reconBy }}
            <span class="sr-ok">✓ 账实相符</span>
          </div>
          <div class="sr-grid">
            <div class="sr-item">
              <b>{{ o.reconSnapshot.batchCount }} 批 / {{ o.reconSnapshot.batchQty }} 件</b>
              <span>采购验收批次勾稽（合格入库）</span>
            </div>
            <div class="sr-item">
              <b>{{ o.reconSnapshot.batchDiff }} 件</b>
              <span>验收差异（已扣款）</span>
            </div>
            <div class="sr-item">
              <b>{{ o.reconSnapshot.stockRemain }}/{{ o.reconSnapshot.stockTotal }}</b>
              <span>SKU 账面 remain/stock</span>
            </div>
            <div class="sr-item" :class="{ muted: !o.reconSnapshot.afterSale }">
              <b>{{ o.reconSnapshot.afterSale ? (o.reconSnapshot.afterSale.done ? '已履约 −1 件' : o.reconSnapshot.afterSale.status) : '无关联' }}</b>
              <span>售后补发{{ o.reconSnapshot.afterSale?.afterSaleId ? `（${o.reconSnapshot.afterSale.afterSaleId}）` : '' }}</span>
            </div>
          </div>
          <div v-if="o.reviewNote" class="s-line muted">复核备注：{{ o.reviewNote }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { usePlatformStore, SUPPLIER_BILL_STATUS, SETTLE_STATUS } from '@/store/platform'

const store = usePlatformStore()

const billMeta = (s) => SUPPLIER_BILL_STATUS[s] || { label: s }
const settleMeta = (s) => SETTLE_STATUS[s] || { label: s }
const fmt = (n) => Number(n || 0).toFixed(2)

const stats = computed(() => ({
  billUnsettled: store.dashboard.billUnsettled,
  settlePending: store.dashboard.settlePending,
  settleDone: store.dashboard.settleDone,
  settleAmount: store.dashboard.settleAmount,
  acceptDiffQty: store.dashboard.acceptDiffQty
}))

// —— 供应商账单（当前租户，最新在前） ——
const billFilters = [
  { key: 'unsettled', label: '待结算' },
  { key: 'settling', label: '结算中' },
  { key: 'settled', label: '已结算' },
  { key: 'all', label: '全部' }
]
const billFilter = ref('unsettled')
const visibleBills = computed(() =>
  [...store.scopedSupplierBills]
    .sort((a, b) => b.ts - a.ts)
    .filter((b) => billFilter.value === 'all' || b.status === billFilter.value))
const billCountOf = (key) =>
  store.scopedSupplierBills.filter((b) => key === 'all' || b.status === key).length

// —— 结算单（当前租户，最新在前） ——
const settleFilters = [
  { key: 'pending', label: '待复核' },
  { key: 'settled', label: '已结算' },
  { key: 'rejected', label: '已驳回' },
  { key: 'all', label: '全部' }
]
const settleFilter = ref('pending')
const visibleSettles = computed(() =>
  [...store.scopedSettleOrders]
    .sort((a, b) => b.ts - a.ts)
    .filter((o) => settleFilter.value === 'all' || o.status === settleFilter.value))
const settleCountOf = (key) =>
  store.scopedSettleOrders.filter((o) => key === 'all' || o.status === key).length

const settleOf = (bill) =>
  bill.settleId ? store.settleOrders.find((o) => o.id === bill.settleId) : null

// —— 发起结算 / 财务复核 ——
const applyNotes = reactive({})
const noteOf = (b) => (applyNotes[b.id] || (applyNotes[b.id] = { note: '' }))
function applySettle(b) {
  const so = store.createSettleOrder(b.id, { note: noteOf(b).note })
  if (so) {
    applyNotes[b.id].note = ''
    billFilter.value = 'settling'
    settleFilter.value = 'pending'
  }
}

const reviewNotes = reactive({})
const reviewNoteOf = (o) => (reviewNotes[o.id] || (reviewNotes[o.id] = { note: '' }))
function review(o, ok) {
  if (store.reviewSettleOrder(o.id, ok, reviewNoteOf(o).note)) {
    reviewNotes[o.id].note = ''
    if (ok) settleFilter.value = 'settled'
  }
}
</script>

<style scoped>
.st-view { display: flex; flex-direction: column; gap: 16px; max-width: 1040px; margin: 0 auto; }

.st-hero {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  background: linear-gradient(135deg, #14352a, #162b55);
  border: 1px solid rgba(38,166,154,0.35); border-radius: 14px; padding: 18px 22px; flex-wrap: wrap;
}
.hero-stats { display: flex; gap: 28px; flex-wrap: wrap; }
.hs-item { display: flex; flex-direction: column; }
.hs-num { font-size: 26px; font-weight: 800; line-height: 1; }
.hs-num.warn { color: #ffb74d; }
.hs-num.info { color: #82b1ff; }
.hs-num.ok { color: #7ef0c9; }
.hs-num.amount { color: #ffd54f; font-size: 22px; }
.hs-num.bad { color: #ef9a9a; }
.hs-lab { font-size: 11px; color: #9db0d0; margin-top: 5px; }
.role-box { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.role-tip { font-size: 11px; color: #9db0d0; }
.role-switch { display: flex; background: rgba(0,0,0,0.25); border-radius: 10px; padding: 3px; }
.role-switch button {
  background: transparent; border: none; color: #aebadd; font-size: 12px;
  padding: 7px 14px; border-radius: 8px; cursor: pointer;
}
.role-switch button.active {
  background: linear-gradient(135deg,#00695c,#00897b); color: #fff;
  box-shadow: 0 3px 8px rgba(0,137,123,0.4);
}

.loop-hint {
  margin: 0; font-size: 11px; color: #8ba2c8; line-height: 1.7;
  background: rgba(38,166,154,0.07); border: 1px dashed rgba(38,166,154,0.35);
  border-radius: 10px; padding: 10px 14px;
}
.loop-hint b { color: #7ef0c9; }

.card {
  background: #0f1b38; border: 1px solid rgba(120,160,220,0.16);
  border-radius: 14px; padding: 16px;
}
.card-title {
  font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 14px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.filters { display: flex; gap: 5px; margin-left: auto; flex-wrap: wrap; }
.filters button {
  background: #13233f; border: 1px solid rgba(120,160,220,0.18); color: #8ba2c8;
  font-size: 11px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
}
.filters button.active { background: #00897b; color: #fff; border-color: transparent; }
.filters em { font-style: normal; opacity: 0.8; }
.op-hint { font-size: 11px; color: #6f84ab; margin: 0 0 12px; }
.empty { color: #5b6f94; text-align: center; padding: 24px; font-size: 12px; }

/* 供应商账单 */
.bill {
  background: rgba(20,34,66,0.5); border: 1px solid rgba(120,160,220,0.14);
  border-left-width: 3px; border-radius: 10px; padding: 13px 14px; margin-bottom: 10px;
}
.bill.unsettled { border-left-color: #ffb74d; }
.bill.settling { border-left-color: #82b1ff; }
.bill.settled { border-left-color: #7ef0c9; }
.b-head { display: flex; align-items: center; gap: 10px; }
.b-icon { font-size: 24px; }
.b-main { flex: 1; min-width: 0; }
.b-title { font-size: 13px; color: #eef3fc; font-weight: 700; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.b-src { font-size: 10px; color: #8ba2c8; font-weight: 400; }
.b-src.shortage { color: #ef9a9a; }
.b-sub { font-size: 10px; color: #6f84ab; margin-top: 2px; }
.b-status { font-size: 11px; padding: 3px 10px; border-radius: 6px; font-weight: 600; flex-shrink: 0; }
.b-status.unsettled { background: rgba(255,183,77,0.18); color: #ffb74d; }
.b-status.settling { background: rgba(130,177,255,0.18); color: #82b1ff; }
.b-status.settled { background: rgba(126,240,201,0.18); color: #7ef0c9; }

.b-amounts { display: flex; gap: 22px; margin-top: 10px; flex-wrap: wrap; }
.ba-item { display: flex; flex-direction: column; }
.ba-num { font-size: 16px; font-weight: 800; color: #dbe4f3; }
.ba-item.diff .ba-num { color: #ef9a9a; }
.ba-item.total .ba-num { color: #ffd54f; }
.ba-lab { font-size: 10px; color: #7e97c2; margin-top: 3px; }

.b-actions { margin-top: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.b-actions input {
  flex: 1; min-width: 200px; background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3;
  border-radius: 8px; padding: 7px 11px; font-size: 12px;
}
.btn-apply {
  background: linear-gradient(135deg,#00897b,#00695c); color: #fff; border: none;
  border-radius: 8px; padding: 7px 15px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.b-linked {
  margin-top: 10px; font-size: 11px; color: #82b1ff;
  background: rgba(130,177,255,0.07); border-radius: 8px; padding: 7px 10px;
}
.b-linked.ok { color: #7ef0c9; background: rgba(126,240,201,0.07); }
.waiting { font-size: 11px; color: #7e97c2; }

/* 结算单 */
.settle {
  background: rgba(20,34,66,0.5); border: 1px solid rgba(120,160,220,0.14);
  border-left-width: 3px; border-radius: 10px; padding: 13px 14px; margin-bottom: 10px;
}
.settle.pending { border-left-color: #ffb74d; }
.settle.settled { border-left-color: #7ef0c9; }
.settle.rejected { border-left-color: #e57373; }
.s-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.s-icon { font-size: 24px; }
.s-main { flex: 1; min-width: 220px; }
.s-title { font-size: 13px; color: #eef3fc; font-weight: 700; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.s-src { font-size: 10px; color: #8ba2c8; font-weight: 400; }
.s-sub { font-size: 10px; color: #6f84ab; margin-top: 2px; }
.s-amount { display: flex; flex-direction: column; align-items: flex-end; }
.s-amount b { font-size: 17px; color: #ffd54f; }
.s-diff { font-size: 10px; color: #ef9a9a; margin-top: 2px; }
.s-status { font-size: 11px; padding: 3px 10px; border-radius: 6px; font-weight: 600; }
.s-status.pending { background: rgba(255,183,77,0.18); color: #ffb74d; }
.s-status.settled { background: rgba(126,240,201,0.18); color: #7ef0c9; }
.s-status.rejected { background: rgba(229,115,115,0.18); color: #ef9a9a; }

.s-body { margin-top: 9px; display: flex; flex-direction: column; gap: 5px; }
.s-line { font-size: 12px; color: #aebadd; }
.s-line.muted { font-size: 11px; color: #7e97c2; }
.s-line.shortage { font-size: 11px; color: #ef9a9a; }

.s-actions { margin-top: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.s-actions input {
  flex: 1; min-width: 180px; background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3;
  border-radius: 8px; padding: 7px 11px; font-size: 12px;
}
.btn-approve {
  background: linear-gradient(135deg,#66bb6a,#43a047); color: #fff; border: none;
  border-radius: 8px; padding: 7px 15px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-reject {
  background: transparent; border: 1px solid rgba(229,115,115,0.5); color: #ef9a9a;
  border-radius: 8px; padding: 7px 15px; font-size: 12px; cursor: pointer;
}
.s-review.rejected {
  margin-top: 10px; font-size: 11px; color: #ef9a9a;
  background: rgba(229,115,115,0.07); border-radius: 8px; padding: 7px 10px;
}

.s-recon {
  margin-top: 10px; background: rgba(38,166,154,0.07);
  border: 1px dashed rgba(38,166,154,0.4); border-radius: 9px; padding: 10px 12px;
}
.sr-title { font-size: 11px; font-weight: 700; color: #7ef0c9; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sr-ok {
  font-size: 10px; background: rgba(126,240,201,0.15); color: #7ef0c9;
  border-radius: 6px; padding: 2px 8px; font-weight: 600;
}
.sr-grid { display: flex; gap: 20px; margin-top: 8px; flex-wrap: wrap; }
.sr-item { display: flex; flex-direction: column; }
.sr-item b { font-size: 13px; color: #eef3fc; }
.sr-item.muted b { color: #7e97c2; }
.sr-item span { font-size: 10px; color: #7e97c2; margin-top: 2px; }
.s-recon .s-line { margin-top: 8px; }
</style>
