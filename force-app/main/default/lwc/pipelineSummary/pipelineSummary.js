import { LightningElement, api } from 'lwc';
import CURRENCY from '@salesforce/i18n/currency';
import LOCALE from '@salesforce/i18n/locale';
import { formatCompactCurrency } from 'c/pipelineUtils';

const money = (v) => formatCompactCurrency(v, CURRENCY, LOCALE);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * KPI tiles (each one is a one-click filter) and a stage funnel.
 * Fires `tileselect` { key } and `stageselect` { stage }.
 */
export default class PipelineSummary extends LightningElement {
    @api kpis;
    @api stageSummary = [];
    @api activeKeys = [];
    @api activeStage;
    @api showFunnel = false;

    get tiles() {
        const k = this.kpis;
        if (!k) {
            return [];
        }
        const winRate = k.winRate === null ? 'no closed deals yet' : `${k.winRate}% win rate`;
        return [
            {
                key: 'open',
                label: 'Open pipeline',
                value: money(k.openAmount),
                detail: `${plural(k.openCount, 'deal')} · avg ${money(k.avgDealSize)}`,
                icon: 'utility:moneybag',
                tone: 'neutral'
            },
            {
                key: 'weighted',
                label: 'Weighted forecast',
                value: money(k.weightedAmount),
                detail: 'amount × probability',
                icon: 'utility:trending',
                tone: 'neutral',
                static: true
            },
            {
                key: 'closingMonth',
                label: 'Closing this month',
                value: money(k.closingMonthAmount),
                detail: plural(k.closingMonthCount, 'deal'),
                icon: 'utility:event',
                tone: 'brand'
            },
            {
                key: 'atRisk',
                label: 'At risk',
                value: money(k.atRiskAmount),
                detail: plural(k.atRiskCount, 'deal'),
                icon: 'utility:warning',
                tone: 'risk'
            },
            {
                key: 'overdue',
                label: 'Past close date',
                value: money(k.overdueAmount),
                detail: plural(k.overdueCount, 'deal'),
                icon: 'utility:clock',
                tone: 'risk'
            },
            {
                key: 'highValue',
                label: 'High value',
                value: money(k.highValueAmount),
                detail: plural(k.highValueCount, 'deal'),
                icon: 'utility:favorite',
                tone: 'gold'
            },
            {
                key: 'won',
                label: 'Won this quarter',
                value: money(k.wonAmount),
                detail: `${plural(k.wonCount, 'deal')} · ${winRate}`,
                icon: 'utility:trophy',
                tone: 'success'
            }
        ].map((t) => {
            const active = (this.activeKeys || []).includes(t.key);
            return {
                ...t,
                active,
                pressed: active ? 'true' : 'false',
                title: t.static ? t.label : `Show ${t.label.toLowerCase()} deals`,
                className: `pcc-tile pcc-tile_${t.tone}${active ? ' pcc-tile_active' : ''}${t.static ? ' pcc-tile_static' : ''}`
            };
        });
    }

    get funnel() {
        return (this.stageSummary || []).map((s) => {
            const active = this.activeStage === s.value;
            return {
                ...s,
                amountText: money(s.amount),
                countText: plural(s.count, 'deal'),
                title: active ? 'Click to show all stages' : `Show only ${s.label}`,
                barStyle: `width:${s.widthPct}%`,
                className: `pcc-step${active ? ' pcc-step_active' : ''}${s.count ? '' : ' pcc-step_empty'}`
            };
        });
    }

    get funnelIcon() {
        return this.showFunnel ? 'utility:chevrondown' : 'utility:chevronright';
    }

    handleTile(event) {
        const { key, static: isStatic } = event.currentTarget.dataset;
        if (isStatic === 'true') {
            return;
        }
        this.dispatchEvent(new CustomEvent('tileselect', { detail: { key } }));
    }

    handleStage(event) {
        this.dispatchEvent(new CustomEvent('stageselect', { detail: { stage: event.currentTarget.dataset.value } }));
    }

    toggleFunnel() {
        this.dispatchEvent(new CustomEvent('togglefunnel'));
    }
}
