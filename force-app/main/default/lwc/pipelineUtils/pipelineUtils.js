/**
 * Pure helpers for the Pipeline Command Center.
 * No Salesforce imports here, so everything is fast to unit test with Jest.
 */

const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function toIsoDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function utcIso(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseIso(iso) {
    if (!iso) {
        return null;
    }
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

/** Whole days from one YYYY-MM-DD to another (negative when `to` is earlier). */
export function daysBetween(fromIso, toIso) {
    const a = parseIso(fromIso);
    const b = parseIso(toIso);
    if (a === null || b === null) {
        return null;
    }
    return Math.round((b - a) / DAY_MS);
}

/** Calendar date range for a named period, relative to today. */
export function getPeriodRange(period, todayIso) {
    const [y, m] = todayIso.split('-').map(Number);
    const month = m - 1;
    const quarterStart = Math.floor(month / 3) * 3;
    const range = (startMonth, months) => ({
        start: utcIso(Date.UTC(y, startMonth, 1)),
        end: utcIso(Date.UTC(y, startMonth + months, 0))
    });
    switch (period) {
        case 'thisMonth':
            return range(month, 1);
        case 'nextMonth':
            return range(month + 1, 1);
        case 'thisQuarter':
            return range(quarterStart, 3);
        case 'nextQuarter':
            return range(quarterStart + 3, 3);
        default:
            return null;
    }
}

function closeLabel(daysToClose, isClosed) {
    if (isClosed || daysToClose === null) {
        return '';
    }
    if (daysToClose < 0) {
        return `${Math.abs(daysToClose)}d overdue`;
    }
    if (daysToClose === 0) {
        return 'Closes today';
    }
    if (daysToClose === 1) {
        return 'Closes tomorrow';
    }
    return `Closes in ${daysToClose}d`;
}

/**
 * Adds the client-side fields every view needs. Server data is kept as is.
 * ctx = { today: 'YYYY-MM-DD', highValueThreshold: Number }
 */
export function decorateDeal(raw, ctx) {
    const isClosed = raw.isClosed === true;
    const amount = raw.amount === undefined ? null : raw.amount;
    const probability = raw.probability === undefined || raw.probability === null ? 0 : raw.probability;
    const daysToClose = daysBetween(ctx.today, raw.closeDate);
    const isOverdue = !isClosed && daysToClose !== null && daysToClose < 0;
    const flags = raw.riskFlags || [];
    const level = raw.healthLevel || 'healthy';
    return {
        ...raw,
        amount,
        probability,
        riskFlags: flags,
        weightedAmount: ((amount || 0) * probability) / 100,
        daysToClose,
        isOverdue,
        isHighValue: (amount || 0) >= ctx.highValueThreshold,
        isAtRisk: !isClosed && level === 'risk',
        hasNoNextStep: !isClosed && !raw.nextStep,
        closeLabel: closeLabel(daysToClose, isClosed),
        closeDateClass: isOverdue ? 'slds-text-color_error' : '',
        riskSummary: flags.map((f) => f.label).join(' · '),
        searchText: [raw.name, raw.accountName, raw.ownerName, raw.stageName, raw.nextStep]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
    };
}

export const QUICK_FILTERS = {
    atRisk: (d) => d.isAtRisk,
    highValue: (d) => d.isHighValue,
    closingSoon: (d) => !d.isClosed && d.daysToClose !== null && d.daysToClose >= 0 && d.daysToClose <= 30,
    overdue: (d) => d.isOverdue,
    noNextStep: (d) => d.hasNoNextStep,
    closingMonth: (d, ctx) => {
        const r = getPeriodRange('thisMonth', ctx.today);
        return !d.isClosed && d.closeDate >= r.start && d.closeDate <= r.end;
    }
};

/**
 * Applies any subset of: search, ownerId, status, stage, period, quick[].
 * A missing or 'all' value means "no filter".
 */
export function filterDeals(deals, filters, ctx) {
    const terms = (filters.search || '').toLowerCase().split(/\s+/).filter(Boolean);
    const ownerId = filters.ownerId && filters.ownerId !== 'all' ? filters.ownerId : null;
    const stage = filters.stage && filters.stage !== 'all' ? filters.stage : null;
    const status = filters.status && filters.status !== 'all' ? filters.status : null;
    const range = filters.period ? getPeriodRange(filters.period, ctx.today) : null;
    const quick = (filters.quick || []).map((k) => QUICK_FILTERS[k]).filter(Boolean);

    return deals.filter((d) => {
        if (ownerId && d.ownerId !== ownerId) {
            return false;
        }
        if (status === 'open' && d.isClosed) {
            return false;
        }
        if (status === 'won' && !d.isWon) {
            return false;
        }
        if (status === 'lost' && (!d.isClosed || d.isWon)) {
            return false;
        }
        if (stage && d.stageName !== stage) {
            return false;
        }
        if (filters.period === 'overdue' && !d.isOverdue) {
            return false;
        }
        if (range && !(d.closeDate >= range.start && d.closeDate <= range.end)) {
            return false;
        }
        if (quick.some((fn) => !fn(d, ctx))) {
            return false;
        }
        return terms.every((t) => d.searchText.includes(t));
    });
}

const sumOf = (deals, field) => deals.reduce((total, d) => total + (Number(d[field]) || 0), 0);

/** KPI numbers for the summary strip. */
export function computeKpis(deals, ctx) {
    const open = deals.filter((d) => !d.isClosed);
    const won = deals.filter((d) => d.isWon);
    const lost = deals.filter((d) => d.isClosed && !d.isWon);
    const pick = (key) => open.filter((d) => QUICK_FILTERS[key](d, ctx));
    const atRisk = pick('atRisk');
    const highValue = pick('highValue');
    const closingMonth = pick('closingMonth');
    const overdue = pick('overdue');
    const decided = won.length + lost.length;
    const openAmount = sumOf(open, 'amount');
    return {
        openCount: open.length,
        openAmount,
        weightedAmount: sumOf(open, 'weightedAmount'),
        avgDealSize: open.length ? openAmount / open.length : 0,
        atRiskCount: atRisk.length,
        atRiskAmount: sumOf(atRisk, 'amount'),
        highValueCount: highValue.length,
        highValueAmount: sumOf(highValue, 'amount'),
        closingMonthCount: closingMonth.length,
        closingMonthAmount: sumOf(closingMonth, 'amount'),
        overdueCount: overdue.length,
        overdueAmount: sumOf(overdue, 'amount'),
        wonCount: won.length,
        wonAmount: sumOf(won, 'amount'),
        lostCount: lost.length,
        winRate: decided ? Math.round((won.length * 100) / decided) : null
    };
}

/** Count and amount per open stage, with a bar width relative to the biggest stage. */
export function buildStageSummary(deals, stages) {
    const rows = stages
        .filter((s) => !s.isClosed)
        .map((s) => {
            const inStage = deals.filter((d) => !d.isClosed && d.stageName === s.value);
            return { value: s.value, label: s.label, count: inStage.length, amount: sumOf(inStage, 'amount') };
        });
    const max = Math.max(1, ...rows.map((r) => r.amount));
    return rows.map((r) => ({ ...r, widthPct: Math.max(r.count ? 2 : 0, Math.round((r.amount / max) * 100)) }));
}

/** Stable sort; empty values always go last. */
export function sortDeals(deals, field, direction) {
    const factor = direction === 'desc' ? -1 : 1;
    return deals
        .map((d, i) => ({ d, i }))
        .sort((a, b) => {
            const x = a.d[field];
            const y = b.d[field];
            const xEmpty = x === null || x === undefined || x === '';
            const yEmpty = y === null || y === undefined || y === '';
            if (xEmpty || yEmpty) {
                return xEmpty === yEmpty ? a.i - b.i : xEmpty ? 1 : -1;
            }
            if (x < y) {
                return -factor;
            }
            if (x > y) {
                return factor;
            }
            return a.i - b.i;
        })
        .map((w) => w.d);
}

const csvCell = (value) => {
    if (value === null || value === undefined) {
        return '';
    }
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv(deals) {
    const columns = [
        ['Opportunity', 'name'],
        ['Account', 'accountName'],
        ['Owner', 'ownerName'],
        ['Stage', 'stageName'],
        ['Amount', 'amount'],
        ['Probability', 'probability'],
        ['Close Date', 'closeDate'],
        ['Health Score', 'healthScore'],
        ['Risks', 'riskSummary'],
        ['Next Step', 'nextStep'],
        ['Last Activity', 'lastActivityDate'],
        ['Id', 'id']
    ];
    const header = columns.map(([label]) => label).join(',');
    const lines = deals.map((d) => columns.map(([, field]) => csvCell(d[field])).join(','));
    return [header, ...lines].join('\n');
}

export function formatCompactCurrency(value, currency, locale) {
    try {
        return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency,
            notation: 'compact',
            maximumFractionDigits: 1
        }).format(value || 0);
    } catch {
        return String(Math.round(value || 0));
    }
}

/** Relative time like "just now", "5m ago", "2h ago". */
export function timeAgo(timestamp, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 45) {
        return 'just now';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    return `${Math.round(hours / 24)}d ago`;
}

/** Turns Apex / UI API / JS errors into one readable message. */
export function reduceErrors(error) {
    if (!error) {
        return 'Unknown error';
    }
    const errors = Array.isArray(error) ? error : [error];
    return errors
        .map((e) => {
            if (typeof e === 'string') {
                return e;
            }
            const body = e.body || {};
            if (body.output) {
                const fieldErrors = Object.values(body.output.fieldErrors || {})
                    .flat()
                    .map((fe) => fe.message);
                const pageErrors = (body.output.errors || []).map((pe) => pe.message);
                const all = [...pageErrors, ...fieldErrors];
                if (all.length) {
                    return all.join(', ');
                }
            }
            if (Array.isArray(body)) {
                return body.map((b) => b.message).join(', ');
            }
            return body.message || e.message || e.statusText || 'Unknown error';
        })
        .filter(Boolean)
        .join(', ');
}
