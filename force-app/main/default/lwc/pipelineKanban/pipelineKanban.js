import { LightningElement, api } from 'lwc';
import CURRENCY from '@salesforce/i18n/currency';
import LOCALE from '@salesforce/i18n/locale';
import { formatCompactCurrency, sortDeals } from 'c/pipelineUtils';

const PAGE_SIZE = 25;
const SORT_DIRECTIONS = { amount: 'desc', healthScore: 'asc', closeDate: 'asc', name: 'asc' };
const money = (v) => formatCompactCurrency(v, CURRENCY, LOCALE);

/**
 * Kanban board: one column per stage.
 * Columns render 25 cards at a time so hundreds of deals stay fast.
 * Fires `stagechange` { recordId, stageName } and `dealselect` { recordId }.
 */
export default class PipelineKanban extends LightningElement {
    @api stages = [];
    @api sortBy = 'closeDate';

    _deals = [];
    @api
    get deals() {
        return this._deals;
    }
    set deals(value) {
        this._deals = value || [];
    }

    limits = {};
    overStage;
    dragId;

    get columns() {
        const byStage = new Map(this.stages.map((s) => [s.value, []]));
        this._deals.forEach((d) => {
            if (byStage.has(d.stageName)) {
                byStage.get(d.stageName).push(d);
            }
        });
        const openStages = this.stages.filter((s) => !s.isClosed);

        return this.stages.map((stage) => {
            const all = sortDeals(byStage.get(stage.value), this.sortBy, SORT_DIRECTIONS[this.sortBy] || 'asc');
            const limit = this.limits[stage.value] || PAGE_SIZE;
            const atRisk = all.filter((d) => d.isAtRisk).length;
            const total = all.reduce((t, d) => t + (d.amount || 0), 0);
            const openIndex = openStages.findIndex((s) => s.value === stage.value);
            const nextStage = openIndex > -1 && openIndex < openStages.length - 1 ? openStages[openIndex + 1] : null;
            const isEmptyClosed = stage.isClosed && all.length === 0;

            let className = 'pcc-column';
            if (stage.isClosed) {
                className += stage.isWon ? ' pcc-column_won' : ' pcc-column_lost';
            }
            if (isEmptyClosed) {
                className += ' pcc-column_zone';
            }
            if (this.overStage === stage.value) {
                className += ' pcc-column_over';
            }

            return {
                key: stage.value,
                label: stage.label,
                count: all.length,
                totalText: money(total),
                atRiskText: atRisk ? `${atRisk} at risk` : '',
                isEmptyClosed,
                zoneText: stage.isWon ? 'Drop here to mark won' : 'Drop here to mark lost',
                isEmpty: all.length === 0 && !stage.isClosed,
                className,
                cards: all.slice(0, limit).map((d) => this.toCard(d, nextStage)),
                remaining: Math.max(0, all.length - limit),
                hasMore: all.length > limit
            };
        });
    }

    toCard(d, nextStage) {
        let className = `pcc-card pcc-card_${d.healthLevel}`;
        if (d.liveLabel) {
            className += ' pcc-card_live';
        }
        const topFlag = d.riskFlags && d.riskFlags.length ? d.riskFlags[0].label : '';
        const moreFlags = d.riskFlags && d.riskFlags.length > 1 ? ` +${d.riskFlags.length - 1}` : '';
        return {
            id: d.id,
            name: d.name,
            accountName: d.accountName,
            ownerName: d.ownerName,
            ownerPhotoUrl: d.ownerPhotoUrl,
            ownerInitials: (d.ownerName || '?')
                .split(' ')
                .map((p) => p[0])
                .join('')
                .slice(0, 2),
            amountText: d.amount ? money(d.amount) : 'No amount',
            probabilityText: d.isClosed ? '' : `${Math.round(d.probability || 0)}%`,
            closeText: d.isClosed ? d.closeDate : d.closeLabel,
            closeClass: d.isOverdue ? 'pcc-close pcc-close_overdue' : 'pcc-close',
            healthScore: d.healthScore,
            healthLevel: d.healthLevel,
            riskFlags: d.riskFlags,
            riskText: topFlag ? `${topFlag}${moreFlags}` : '',
            isHighValue: d.isHighValue,
            liveLabel: d.liveLabel,
            className,
            hasNext: !!nextStage && !d.isClosed,
            nextStage: nextStage ? nextStage.value : null,
            nextTitle: nextStage ? `Move to ${nextStage.label}` : ''
        };
    }

    // ---- interactions

    handleOpen(event) {
        event.preventDefault();
        this.fire('dealselect', { recordId: event.currentTarget.dataset.id });
    }

    handleAdvance(event) {
        event.stopPropagation();
        const { id, stage } = event.currentTarget.dataset;
        this.fire('stagechange', { recordId: id, stageName: stage });
    }

    handleShowMore(event) {
        const stage = event.currentTarget.dataset.stage;
        this.limits = { ...this.limits, [stage]: (this.limits[stage] || PAGE_SIZE) + PAGE_SIZE };
    }

    handleDragStart(event) {
        this.dragId = event.currentTarget.dataset.id;
        try {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', this.dragId);
        } catch {
            // Some browsers restrict dataTransfer; dragId is enough.
        }
    }

    handleDragEnd() {
        this.dragId = null;
        this.overStage = null;
    }

    handleDragOver(event) {
        event.preventDefault();
        const stage = event.currentTarget.dataset.stage;
        if (this.overStage !== stage) {
            this.overStage = stage;
        }
    }

    handleDragLeave(event) {
        if (!event.currentTarget.contains(event.relatedTarget)) {
            this.overStage = null;
        }
    }

    handleDrop(event) {
        event.preventDefault();
        const stage = event.currentTarget.dataset.stage;
        let id = this.dragId;
        if (!id) {
            try {
                id = event.dataTransfer.getData('text/plain');
            } catch {
                id = null;
            }
        }
        this.dragId = null;
        this.overStage = null;
        const deal = this._deals.find((d) => d.id === id);
        if (deal && deal.stageName !== stage) {
            this.fire('stagechange', { recordId: id, stageName: stage });
        }
    }

    fire(name, detail) {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }
}
