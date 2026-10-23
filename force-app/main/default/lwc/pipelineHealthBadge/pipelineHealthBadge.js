import { LightningElement, api } from 'lwc';

const LEVEL_LABELS = { risk: 'At risk', watch: 'Watch', healthy: 'Healthy', closed: 'Closed' };
const SEVERITY_ICONS = { high: 'utility:error', medium: 'utility:warning', low: 'utility:info' };

/**
 * Health score pill. variant="compact" (table / card) or "full" (side panel, lists every reason).
 */
export default class PipelineHealthBadge extends LightningElement {
    @api score;
    @api level = 'healthy';
    @api variant = 'compact';

    _flags = [];
    @api
    get flags() {
        return this._flags;
    }
    set flags(value) {
        this._flags = Array.isArray(value) ? value : [];
    }

    get isFull() {
        return this.variant === 'full';
    }

    get isPill() {
        return this.variant === 'pill';
    }

    get isClosed() {
        return this.level === 'closed';
    }

    get showOnTrack() {
        return !this.isClosed;
    }

    get pillClass() {
        return `pcc-pill pcc-pill_${this.level || 'healthy'}`;
    }

    get levelLabel() {
        return LEVEL_LABELS[this.level] || '';
    }

    get pillText() {
        return this.isClosed ? 'Closed' : `${this.score ?? '–'}`;
    }

    get topReason() {
        if (this.isClosed) {
            return '';
        }
        if (!this._flags.length) {
            return 'On track';
        }
        const extra = this._flags.length > 1 ? ` +${this._flags.length - 1}` : '';
        return `${this._flags[0].label}${extra}`;
    }

    get tooltip() {
        if (!this._flags.length) {
            return `${this.levelLabel}`;
        }
        return `${this.levelLabel}: ${this._flags.map((f) => f.label).join(', ')}`;
    }

    get reasons() {
        return this._flags.map((f) => ({
            ...f,
            key: f.code,
            icon: SEVERITY_ICONS[f.severity] || SEVERITY_ICONS.low,
            iconVariant: f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warning' : '',
            penaltyText: `−${f.penalty}`
        }));
    }

    get hasReasons() {
        return this._flags.length > 0;
    }
}
