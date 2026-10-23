import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { updateRecord } from 'lightning/uiRecordApi';
import { subscribe, unsubscribe, onError, isEmpEnabled } from 'lightning/empApi';
import LightningConfirm from 'lightning/confirm';
import CURRENCY from '@salesforce/i18n/currency';
import LOCALE from '@salesforce/i18n/locale';
import USER_ID from '@salesforce/user/Id';
import getPipeline from '@salesforce/apex/PipelineCommandCenterController.getPipeline';
import getChanges from '@salesforce/apex/PipelineCommandCenterController.getChanges';
import {
    buildStageSummary,
    computeKpis,
    decorateDeal,
    filterDeals,
    formatCompactCurrency,
    reduceErrors,
    sortDeals,
    timeAgo,
    toCsv,
    toIsoDate
} from 'c/pipelineUtils';

// Custom channel (packageable) that carries Opportunity change events.
const CHANGE_CHANNEL = '/data/PipelineCommandCenter__chn';
const POLL_MS = 45000;
const TICK_MS = 30000;
const LIVE_MARK_MS = 3 * 60 * 1000;
const CHANGE_DEBOUNCE_MS = 800;
const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;
const STORAGE_KEY = 'pcc.prefs.v1';

// Datatable column -> Opportunity field for inline edits.
const EDITABLE_FIELDS = {
    stageName: 'StageName',
    amount: 'Amount',
    probability: 'Probability',
    closeDate: 'CloseDate',
    nextStep: 'NextStep'
};
const NUMERIC_FIELDS = new Set(['amount', 'probability']);

const FIELD_LABELS = {
    StageName: 'stage',
    Amount: 'amount',
    CloseDate: 'close date',
    OwnerId: 'owner',
    NextStep: 'next step',
    Probability: 'probability',
    Name: 'name',
    ForecastCategoryName: 'forecast category',
    Description: 'description',
    AccountId: 'account',
    Type: 'type'
};

const ROW_ACTIONS = [
    { label: 'Open details', name: 'details', iconName: 'utility:side_list' },
    { label: 'View record', name: 'view', iconName: 'utility:new_window' },
    { label: 'Mark as won', name: 'won', iconName: 'utility:success' },
    { label: 'Mark as lost', name: 'lost', iconName: 'utility:close' }
];

const DEFAULT_FILTERS = Object.freeze({
    search: '',
    ownerId: 'all',
    stage: 'all',
    period: 'all',
    status: 'open',
    quick: []
});

const TILE_QUICK_KEYS = ['closingMonth', 'atRisk', 'overdue', 'highValue'];
const CHIP_DEFS = [
    { key: 'closingSoon', label: 'Closing in 30 days' },
    { key: 'noNextStep', label: 'No next step' }
];

export default class PipelineCommandCenter extends NavigationMixin(LightningElement) {
    @api cardTitle = 'Pipeline Command Center';
    @api highValueThreshold = 100000;
    @api staleDays = 14;
    @api defaultView = 'list';
    @api defaultScope = 'TEAM';

    // data
    allDeals = [];
    stages = [];
    hasTeam = false;
    truncated = false;
    maxRecords = 0;
    isLoading = true;
    isSaving = false;
    error;

    // view state
    scope;
    view;
    showFunnel = true;
    filters = { ...DEFAULT_FILTERS };
    searchInput = '';
    sortedBy = 'closeDate';
    sortedDirection = 'asc';
    kanbanSort = 'closeDate';
    rowLimit = PAGE_SIZE;
    draftValues = [];
    tableErrors;
    selectedId;
    showFeed = false;

    // derived (recomputed on change, not on every render)
    rows = [];
    sortedRows = [];
    kpis;
    stageSummary = [];
    ownerOptions = [];

    // live collaboration
    liveMode = 'connecting';
    feed = [];
    unseen = 0;
    liveMarks = {};
    lastSync;
    lastSyncAt;
    nowTick = Date.now();

    _ctx;
    _subscription;
    _pending = new Map();
    _timers = {};

    // ------------------------------------------------------------ lifecycle

    connectedCallback() {
        const prefs = this.readPrefs();
        this.scope = prefs.scope || (this.defaultScope || 'TEAM').toUpperCase();
        this.view = prefs.view || this.defaultView || 'list';
        if (prefs.showFunnel !== undefined) {
            this.showFunnel = prefs.showFunnel;
        }
        this.load();
        this.initLive();
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this._timers.tick = setInterval(() => {
            this.nowTick = Date.now();
        }, TICK_MS);
    }

    disconnectedCallback() {
        if (this._subscription) {
            unsubscribe(this._subscription, () => {});
            this._subscription = null;
        }
        clearInterval(this._timers.tick);
        clearInterval(this._timers.poll);
        clearTimeout(this._timers.flush);
        clearTimeout(this._timers.search);
    }

    get ctx() {
        if (!this._ctx) {
            this._ctx = {
                today: toIsoDate(new Date()),
                highValueThreshold: Number(this.highValueThreshold) || 100000
            };
        }
        return this._ctx;
    }

    get staleDaysValue() {
        return Number(this.staleDays) || 14;
    }

    // ------------------------------------------------------------ data

    async load() {
        this.isLoading = true;
        this._ctx = null;
        try {
            const data = await getPipeline({ scope: this.scope, staleDays: this.staleDaysValue });
            this.stages = data.stages || [];
            this.hasTeam = data.hasTeam;
            this.truncated = data.truncated;
            this.maxRecords = data.maxRecords;
            this.lastSync = data.serverTime;
            this.lastSyncAt = Date.now();
            this.allDeals = (data.deals || []).map((d) => decorateDeal(d, this.ctx));
            this.error = undefined;
            this.rowLimit = PAGE_SIZE;
            this.recompute();
        } catch (e) {
            this.error = reduceErrors(e);
        } finally {
            this.isLoading = false;
        }
    }

    /** Re-fetches specific deals and merges them in place. */
    async syncRecords(ids) {
        if (!ids.length) {
            return [];
        }
        const result = await getChanges({
            scope: this.scope,
            sinceIso: null,
            recordIds: ids,
            staleDays: this.staleDaysValue
        });
        this.mergeDeals(result.deals);
        return result.deals;
    }

    mergeDeals(dtos) {
        if (!dtos || !dtos.length) {
            return;
        }
        const byId = new Map(this.allDeals.map((d) => [d.id, d]));
        dtos.forEach((dto) => {
            if (dto.inScope) {
                byId.set(dto.id, decorateDeal(dto, this.ctx));
            } else {
                byId.delete(dto.id);
            }
        });
        this.allDeals = Array.from(byId.values());
        this.lastSyncAt = Date.now();
        this.recompute();
    }

    replaceDeal(deal) {
        this.allDeals = this.allDeals.map((d) => (d.id === deal.id ? deal : d));
        this.recompute();
    }

    /** Single place where filters, KPIs and view rows are derived. */
    recompute() {
        const ctx = this.ctx;
        const f = this.filters;
        // KPIs and the funnel respond to search + owner, but not to the tile/stage filters,
        // so the tiles always show the full picture you are slicing.
        const context = filterDeals(this.allDeals, { search: f.search, ownerId: f.ownerId }, ctx);
        this.kpis = computeKpis(context, ctx);
        this.stageSummary = buildStageSummary(context, this.stages);

        const visible = filterDeals(
            context,
            { status: f.status, stage: f.stage, period: f.period, quick: f.quick },
            ctx
        ).map((d) => this.withLive(d));
        this.rows = visible;
        this.sortedRows = sortDeals(visible, this.sortedBy, this.sortedDirection);

        const owners = new Map();
        this.allDeals.forEach((d) => owners.set(d.ownerId, d.ownerName));
        this.ownerOptions = [
            { label: 'All owners', value: 'all' },
            ...Array.from(owners, ([value, label]) => ({ value, label: label || 'Unknown' })).sort((a, b) =>
                a.label.localeCompare(b.label)
            )
        ];

        if (this.selectedId && !this.allDeals.some((d) => d.id === this.selectedId)) {
            this.selectedId = null;
        }
    }

    withLive(d) {
        const mark = this.liveMarks[d.id];
        return mark ? { ...d, liveLabel: mark.label } : d;
    }

    // ------------------------------------------------------------ getters for the template

    get hasData() {
        return !this.isLoading && !this.error;
    }

    get isListView() {
        return this.view === 'list';
    }

    get isKanbanView() {
        return this.view === 'kanban';
    }

    get listVariant() {
        return this.isListView ? 'brand' : 'border';
    }

    get kanbanVariant() {
        return this.isKanbanView ? 'brand' : 'border';
    }

    get tableRows() {
        return this.sortedRows.slice(0, this.rowLimit);
    }

    get canLoadMore() {
        return this.rowLimit < this.sortedRows.length;
    }

    get hasRows() {
        return this.rows.length > 0;
    }

    get resultLabel() {
        const shown = this.isListView ? Math.min(this.rowLimit, this.sortedRows.length) : this.rows.length;
        const total = this.rows.length;
        const amount = formatCompactCurrency(
            this.rows.reduce((t, d) => t + (d.amount || 0), 0),
            CURRENCY,
            LOCALE
        );
        const base = `${total} deal${total === 1 ? '' : 's'} · ${amount}`;
        return this.isListView && shown < total ? `${base} · showing ${shown}, scroll for more` : base;
    }

    get subtitle() {
        const scope = this.scopeOptions.find((o) => o.value === this.scope);
        const synced = this.lastSyncAt ? `Synced ${timeAgo(this.lastSyncAt, this.nowTick)}` : '';
        return [scope && scope.label, synced].filter(Boolean).join(' · ');
    }

    get scopeOptions() {
        return [
            { label: this.hasTeam ? 'My team' : 'My team (no direct reports)', value: 'TEAM' },
            { label: 'My deals', value: 'MINE' },
            { label: 'All I can see', value: 'ALL' }
        ];
    }

    get stageOptions() {
        return this.stages.map((s) => ({ label: s.label, value: s.value }));
    }

    get stageFilterOptions() {
        return [{ label: 'All stages', value: 'all' }, ...this.stageOptions];
    }

    get periodOptions() {
        return [
            { label: 'Any close date', value: 'all' },
            { label: 'Past close date', value: 'overdue' },
            { label: 'This month', value: 'thisMonth' },
            { label: 'Next month', value: 'nextMonth' },
            { label: 'This quarter', value: 'thisQuarter' },
            { label: 'Next quarter', value: 'nextQuarter' }
        ];
    }

    get statusOptions() {
        return [
            { label: 'Open deals', value: 'open' },
            { label: 'Won this quarter', value: 'won' },
            { label: 'Lost this quarter', value: 'lost' }
        ];
    }

    get kanbanSortOptions() {
        return [
            { label: 'Close date (soonest)', value: 'closeDate' },
            { label: 'Amount (largest)', value: 'amount' },
            { label: 'Health (worst first)', value: 'healthScore' },
            { label: 'Name', value: 'name' }
        ];
    }

    get chips() {
        return CHIP_DEFS.map((c) => {
            const active = this.filters.quick.includes(c.key);
            return { ...c, variant: active ? 'brand' : 'neutral', pressed: active };
        });
    }

    get activeTileKeys() {
        const f = this.filters;
        const keys = f.quick.filter((k) => TILE_QUICK_KEYS.includes(k));
        if (f.status === 'won') {
            keys.push('won');
        } else if (f.status === 'open' && !keys.length) {
            keys.push('open');
        }
        return keys;
    }

    get hasActiveFilters() {
        const f = this.filters;
        return (
            !!f.search ||
            f.ownerId !== 'all' ||
            f.stage !== 'all' ||
            f.period !== 'all' ||
            f.status !== 'open' ||
            f.quick.length > 0
        );
    }

    get columns() {
        return [
            {
                label: 'Opportunity',
                fieldName: 'name',
                type: 'deal',
                sortable: true,
                initialWidth: 240,
                hideDefaultActions: true,
                typeAttributes: {
                    recordId: { fieldName: 'id' },
                    liveLabel: { fieldName: 'liveLabel' },
                    isHighValue: { fieldName: 'isHighValue' }
                }
            },
            { label: 'Account', fieldName: 'accountName', sortable: true, initialWidth: 150, hideDefaultActions: true },
            { label: 'Owner', fieldName: 'ownerName', sortable: true, initialWidth: 130, hideDefaultActions: true },
            {
                label: 'Stage',
                fieldName: 'stageName',
                type: 'picklist',
                editable: true,
                sortable: true,
                initialWidth: 165,
                hideDefaultActions: true,
                typeAttributes: { options: this.stageOptions, placeholder: 'Choose stage' }
            },
            {
                label: 'Amount',
                fieldName: 'amount',
                type: 'currency',
                editable: true,
                sortable: true,
                initialWidth: 110,
                hideDefaultActions: true,
                typeAttributes: { currencyCode: CURRENCY, maximumFractionDigits: 0 }
            },
            {
                label: 'Prob. %',
                fieldName: 'probability',
                type: 'number',
                editable: true,
                sortable: true,
                initialWidth: 70,
                hideDefaultActions: true,
                typeAttributes: { maximumFractionDigits: 0 }
            },
            {
                label: 'Close Date',
                fieldName: 'closeDate',
                type: 'date-local',
                editable: true,
                sortable: true,
                initialWidth: 120,
                hideDefaultActions: true,
                typeAttributes: { month: 'short', day: 'numeric', year: 'numeric' },
                cellAttributes: { class: { fieldName: 'closeDateClass' } }
            },
            {
                label: 'Health',
                fieldName: 'healthScore',
                type: 'health',
                sortable: true,
                initialWidth: 250,
                hideDefaultActions: true,
                typeAttributes: { level: { fieldName: 'healthLevel' }, flags: { fieldName: 'riskFlags' } }
            },
            { label: 'Next Step', fieldName: 'nextStep', editable: true, initialWidth: 200, hideDefaultActions: true },
            {
                label: 'Last Activity',
                fieldName: 'lastActivityDate',
                type: 'date-local',
                sortable: true,
                initialWidth: 120,
                hideDefaultActions: true,
                typeAttributes: { month: 'short', day: 'numeric' }
            },
            { type: 'action', typeAttributes: { rowActions: ROW_ACTIONS } }
        ];
    }

    get selectedDeal() {
        return this.selectedId ? this.allDeals.find((d) => d.id === this.selectedId) : null;
    }

    get showSide() {
        return !!this.selectedDeal || this.showFeed;
    }

    get workspaceClass() {
        return this.showSide ? 'pcc-workspace pcc-workspace_split' : 'pcc-workspace';
    }

    get liveLabel() {
        if (this.liveMode === 'live') {
            return 'Live';
        }
        if (this.liveMode === 'polling') {
            return 'Auto-refresh';
        }
        return 'Connecting';
    }

    get liveTitle() {
        if (this.liveMode === 'live') {
            return 'Changes by your team appear instantly (Change Data Capture).';
        }
        if (this.liveMode === 'polling') {
            return `Checking for teammates' changes every ${POLL_MS / 1000} seconds.`;
        }
        return 'Connecting to live updates...';
    }

    get liveClass() {
        return `pcc-live pcc-live_${this.liveMode}`;
    }

    get feedButtonLabel() {
        return this.unseen ? `Team activity (${this.unseen})` : 'Team activity';
    }

    get feedVariant() {
        return this.showFeed ? 'brand' : this.unseen ? 'brand-outline' : 'neutral';
    }

    get feedItems() {
        return this.feed.map((f) => ({ ...f, when: timeAgo(f.at, this.nowTick) }));
    }

    get hasFeed() {
        return this.feed.length > 0;
    }

    get truncatedMessage() {
        return `Showing the first ${this.maxRecords} deals. Switch to "My team" or "My deals" to see everything in scope.`;
    }

    // ------------------------------------------------------------ toolbar handlers

    handleScope(event) {
        this.scope = event.detail.value;
        this.savePrefs();
        this.load();
    }

    handleView(event) {
        this.view = event.currentTarget.dataset.view;
        this.savePrefs();
    }

    handleRefresh() {
        this.load();
    }

    handleSearch(event) {
        this.searchInput = event.target.value || '';
        clearTimeout(this._timers.search);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this._timers.search = setTimeout(() => this.setFilters({ search: this.searchInput.trim() }), SEARCH_DEBOUNCE_MS);
    }

    handleFilter(event) {
        const field = event.target.dataset.field;
        const update = { [field]: event.detail.value };
        if (field === 'status' && event.detail.value !== 'open') {
            update.quick = [];
        }
        this.setFilters(update);
    }

    handleChip(event) {
        this.toggleQuick(event.currentTarget.dataset.key);
    }

    handleTile(event) {
        const { key } = event.detail;
        if (key === 'open') {
            this.setFilters({ status: 'open', quick: [], period: 'all', stage: 'all' });
        } else if (key === 'won') {
            this.setFilters({ status: this.filters.status === 'won' ? 'open' : 'won', quick: [] });
        } else {
            this.toggleQuick(key);
        }
    }

    handleStageFilter(event) {
        const { stage } = event.detail;
        this.setFilters({ stage: this.filters.stage === stage ? 'all' : stage, status: 'open' });
    }

    handleToggleFunnel() {
        this.showFunnel = !this.showFunnel;
        this.savePrefs();
    }

    handleKanbanSort(event) {
        this.kanbanSort = event.detail.value;
    }

    handleClearFilters() {
        this.searchInput = '';
        this.setFilters({ ...DEFAULT_FILTERS, quick: [] });
    }

    toggleQuick(key) {
        const quick = this.filters.quick.includes(key)
            ? this.filters.quick.filter((k) => k !== key)
            : [...this.filters.quick, key];
        this.setFilters({ quick, status: 'open' });
    }

    setFilters(update) {
        this.filters = { ...this.filters, ...update };
        this.rowLimit = PAGE_SIZE;
        this.recompute();
    }

    handleExport() {
        const csv = toCsv(this.sortedRows);
        const link = document.createElement('a');
        link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
        link.download = `pipeline-${this.ctx.today}.csv`;
        link.click();
    }

    // ------------------------------------------------------------ list view

    handleSort(event) {
        this.sortedBy = event.detail.fieldName;
        this.sortedDirection = event.detail.sortDirection;
        this.sortedRows = sortDeals(this.rows, this.sortedBy, this.sortedDirection);
    }

    handleLoadMore() {
        if (this.canLoadMore) {
            this.rowLimit += PAGE_SIZE;
        }
    }

    handleCancel() {
        this.draftValues = [];
        this.tableErrors = null;
    }

    async handleSave(event) {
        const drafts = event.detail.draftValues || [];
        if (!drafts.length) {
            return;
        }
        this.isSaving = true;
        const results = await Promise.allSettled(
            drafts.map((draft) => {
                const fields = { Id: draft.id };
                Object.keys(draft).forEach((key) => {
                    if (!EDITABLE_FIELDS[key]) {
                        return;
                    }
                    let value = draft[key] === '' ? null : draft[key];
                    if (value !== null && NUMERIC_FIELDS.has(key)) {
                        value = Number(value);
                    }
                    fields[EDITABLE_FIELDS[key]] = value;
                });
                return updateRecord({ fields });
            })
        );

        const rowErrors = {};
        const savedIds = [];
        results.forEach((result, i) => {
            const draft = drafts[i];
            if (result.status === 'fulfilled') {
                savedIds.push(draft.id);
            } else {
                rowErrors[draft.id] = {
                    title: 'Could not save',
                    messages: [reduceErrors(result.reason)],
                    fieldNames: Object.keys(draft).filter((k) => k !== 'id')
                };
            }
        });

        const failed = Object.keys(rowErrors).length;
        this.draftValues = drafts.filter((d) => rowErrors[d.id]);
        this.tableErrors = failed
            ? {
                  rows: rowErrors,
                  table: { title: `${failed} deal${failed === 1 ? '' : 's'} not saved`, messages: ['See row errors.'] }
              }
            : null;

        if (savedIds.length) {
            this.toast(
                'Saved',
                `${savedIds.length} deal${savedIds.length === 1 ? '' : 's'} updated.`,
                'success'
            );
            try {
                await this.syncRecords(savedIds);
            } catch (e) {
                this.toast('Saved, but refresh failed', reduceErrors(e), 'warning');
            }
        }
        this.isSaving = false;
    }

    handleRowAction(event) {
        const action = event.detail.action.name;
        const row = event.detail.row;
        if (action === 'details') {
            this.openDeal(row.id);
        } else if (action === 'view') {
            this.navigateToRecord(row.id);
        } else if (action === 'won' || action === 'lost') {
            const stage = this.stages.find((s) => s.isClosed && s.isWon === (action === 'won'));
            if (stage) {
                this.changeStage(row.id, stage.value);
            }
        }
    }

    // ------------------------------------------------------------ shared deal actions

    handleDealSelect(event) {
        this.openDeal(event.detail.recordId);
    }

    openDeal(id) {
        this.selectedId = id;
        this.showFeed = false;
    }

    handlePanelClose() {
        this.selectedId = null;
    }

    async handleDealSaved(event) {
        try {
            await this.syncRecords([event.detail.recordId]);
        } catch (e) {
            this.toast('Could not refresh deal', reduceErrors(e), 'warning');
        }
    }

    handleStageChange(event) {
        this.changeStage(event.detail.recordId, event.detail.stageName);
    }

    /** Optimistic stage change: the card moves at once, rolls back if Salesforce rejects it. */
    async changeStage(recordId, stageName) {
        const deal = this.allDeals.find((d) => d.id === recordId);
        const stage = this.stages.find((s) => s.value === stageName);
        if (!deal || !stage || deal.stageName === stageName) {
            return;
        }
        if (stage.isClosed) {
            const confirmed = await LightningConfirm.open({
                message: stage.isWon
                    ? `Mark "${deal.name}" as won?`
                    : `Mark "${deal.name}" as lost? It will leave the open pipeline.`,
                label: stage.label,
                theme: stage.isWon ? 'success' : 'warning'
            });
            if (!confirmed) {
                return;
            }
        }

        const previous = deal;
        this.replaceDeal(
            decorateDeal(
                {
                    ...deal,
                    stageName,
                    probability: stage.probability,
                    isClosed: stage.isClosed,
                    isWon: stage.isWon,
                    healthLevel: stage.isClosed ? 'closed' : deal.healthLevel
                },
                this.ctx
            )
        );

        try {
            await updateRecord({ fields: { Id: recordId, StageName: stageName } });
            this.toast('Stage updated', `${deal.name} → ${stage.label}`, 'success');
            await this.syncRecords([recordId]);
        } catch (e) {
            this.replaceDeal(previous);
            this.toast('Could not move deal', reduceErrors(e), 'error');
        }
    }

    navigateToRecord(recordId) {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId, objectApiName: 'Opportunity', actionName: 'view' }
        });
    }

    // ------------------------------------------------------------ live collaboration

    async initLive() {
        try {
            const enabled = await isEmpEnabled();
            if (!enabled) {
                throw new Error('Streaming is not available');
            }
            onError((err) => this.fallBackToPolling(err));
            this._subscription = await subscribe(CHANGE_CHANNEL, -1, (message) => this.handleChangeEvent(message));
            this.liveMode = 'live';
        } catch (e) {
            this.fallBackToPolling(e);
        }
    }

    fallBackToPolling(reason) {
        // Visible in the browser console so admins can see why live updates are off.
        console.warn(`Pipeline Command Center: live updates unavailable on ${CHANGE_CHANNEL}, checking every ${POLL_MS / 1000}s instead.`, JSON.stringify(reason));
        this.liveMode = 'polling';
        if (!this._timers.poll) {
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            this._timers.poll = setInterval(() => this.poll(), POLL_MS);
        }
    }

    handleChangeEvent(message) {
        const header = message && message.data && message.data.payload && message.data.payload.ChangeEventHeader;
        if (!header) {
            return;
        }
        const type = header.changeType || '';
        if (type.startsWith('GAP')) {
            // Too many or untracked changes: just reload quietly.
            this.load();
            return;
        }
        const ids = header.recordIds || [];
        if (type === 'DELETE') {
            const removed = this.allDeals.filter((d) => ids.includes(d.id));
            if (removed.length) {
                this.allDeals = this.allDeals.filter((d) => !ids.includes(d.id));
                removed.forEach((d) =>
                    this.addFeedItem({ id: d.id, name: d.name }, 'deleted', header.commitUser, 'Someone')
                );
                this.recompute();
            }
            return;
        }
        ids.forEach((id) =>
            this._pending.set(id, { changeType: type, fields: header.changedFields || [], commitUser: header.commitUser })
        );
        clearTimeout(this._timers.flush);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this._timers.flush = setTimeout(() => this.flushChanges(), CHANGE_DEBOUNCE_MS);
    }

    async flushChanges() {
        const batch = this._pending;
        this._pending = new Map();
        if (!batch.size) {
            return;
        }
        try {
            const before = new Map(this.allDeals.map((d) => [d.id, d]));
            const dtos = await this.syncRecords(Array.from(batch.keys()));
            dtos.forEach((dto) => {
                const prev = before.get(dto.id);
                // Skip changes we already have (e.g. our own save, synced right after it).
                if ((!prev && !dto.inScope) || (prev && prev.lastModifiedDate === dto.lastModifiedDate)) {
                    return;
                }
                const info = batch.get(dto.id);
                this.addFeedItem(dto, this.describeChange(dto, info), info.commitUser || dto.lastModifiedById);
            });
        } catch {
            // A failed live refresh should never interrupt the manager; the next event or refresh catches up.
        }
    }

    async poll() {
        if (document.hidden || this.isLoading || !this.lastSync) {
            return;
        }
        try {
            // Overlap 5s so commits that landed during the last request are not missed.
            const since = new Date(new Date(this.lastSync).getTime() - 5000).toISOString();
            const result = await getChanges({
                scope: this.scope,
                sinceIso: since,
                recordIds: [],
                staleDays: this.staleDaysValue
            });
            const before = new Map(this.allDeals.map((d) => [d.id, d]));
            this.lastSync = result.serverTime;
            this.mergeDeals(result.deals);
            this.lastSyncAt = Date.now();
            result.deals.forEach((dto) => {
                const prev = before.get(dto.id);
                if ((!prev && !dto.inScope) || (prev && prev.lastModifiedDate === dto.lastModifiedDate)) {
                    return;
                }
                this.addFeedItem(dto, prev ? 'updated' : 'created', dto.lastModifiedById);
            });
        } catch {
            // Ignore and try again on the next tick.
        }
    }

    describeChange(dto, info) {
        if (!info || info.changeType === 'CREATE') {
            return info ? 'created' : 'updated';
        }
        if (info.changeType === 'UNDELETE') {
            return 'restored';
        }
        const fields = info.fields || [];
        if (fields.includes('StageName')) {
            return `moved to ${dto.stageName}`;
        }
        if (fields.includes('OwnerId')) {
            return `reassigned to ${dto.ownerName}`;
        }
        if (fields.includes('Amount')) {
            return `changed amount to ${formatCompactCurrency(dto.amount, CURRENCY, LOCALE)}`;
        }
        if (fields.includes('CloseDate')) {
            return `moved close date to ${dto.closeDate}`;
        }
        const labels = fields.map((f) => FIELD_LABELS[f]).filter(Boolean);
        return labels.length ? `updated ${labels.join(', ')}` : 'updated';
    }

    addFeedItem(deal, action, userId, fallbackName) {
        const mine = userId === USER_ID;
        const who = mine ? 'You' : deal.lastModifiedByName || fallbackName || 'A teammate';
        this.feed = [
            {
                key: `${deal.id}-${Date.now()}-${this.feed.length}`,
                recordId: deal.id,
                dealName: deal.name,
                who,
                action,
                at: Date.now(),
                className: mine ? 'pcc-feed-item pcc-feed-item_mine' : 'pcc-feed-item'
            },
            ...this.feed
        ].slice(0, 50);

        if (!mine) {
            if (!this.showFeed) {
                this.unseen += 1;
            }
            this.markLive(deal.id, `${who.split(' ')[0]}: ${action}`);
        }
    }

    markLive(id, label) {
        this.liveMarks = { ...this.liveMarks, [id]: { label } };
        this.recompute();
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            const marks = { ...this.liveMarks };
            delete marks[id];
            this.liveMarks = marks;
            this.recompute();
        }, LIVE_MARK_MS);
    }

    handleToggleFeed() {
        this.showFeed = !this.showFeed;
        if (this.showFeed) {
            this.selectedId = null;
            this.unseen = 0;
        }
    }

    handleFeedOpen(event) {
        event.preventDefault();
        const id = event.currentTarget.dataset.id;
        if (this.allDeals.some((d) => d.id === id)) {
            this.openDeal(id);
        }
    }

    // ------------------------------------------------------------ utils

    readPrefs() {
        try {
            return JSON.parse(window.localStorage.getItem(STORAGE_KEY)) || {};
        } catch {
            return {};
        }
    }

    savePrefs() {
        try {
            window.localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({ scope: this.scope, view: this.view, showFunnel: this.showFunnel })
            );
        } catch {
            // Preferences are a convenience only.
        }
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
