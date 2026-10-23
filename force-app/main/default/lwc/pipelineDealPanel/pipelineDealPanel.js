import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import CURRENCY from '@salesforce/i18n/currency';
import LOCALE from '@salesforce/i18n/locale';
import getDealInsights from '@salesforce/apex/PipelineCommandCenterController.getDealInsights';
import postCoachingNote from '@salesforce/apex/PipelineCommandCenterController.postCoachingNote';
import createFollowUpTask from '@salesforce/apex/PipelineCommandCenterController.createFollowUpTask';
import { formatCompactCurrency, reduceErrors, toIsoDate, timeAgo } from 'c/pipelineUtils';

const PRIORITY_OPTIONS = [
    { label: 'High', value: 'High' },
    { label: 'Normal', value: 'Normal' },
    { label: 'Low', value: 'Low' }
];

const NOTE_TEMPLATES = [
    { label: 'Confirm budget', value: 'Can you confirm budget and who signs off? Want to be sure this closes on time.' },
    { label: 'Update next step', value: 'Please update the next step and close date so the forecast is accurate.' },
    { label: 'Need exec help?', value: 'Would an exec sponsor call help here? Happy to join.' },
    { label: 'Re-engage', value: 'No activity for a while - can you re-engage the customer this week?' }
];

/**
 * Side panel for one deal: why it is at risk, edit the key fields,
 * coach the owner through Chatter, and assign follow-up tasks.
 * Fires `close` and `dealsaved` { recordId }.
 */
export default class PipelineDealPanel extends NavigationMixin(LightningElement) {
    _deal;
    insights = { posts: [], tasks: [] };
    loadingInsights = false;
    activeTab = 'update';

    note = '';
    posting = false;

    taskSubject = '';
    taskDue = '';
    taskPriority = 'Normal';
    taskComments = '';
    savingTask = false;

    priorityOptions = PRIORITY_OPTIONS;
    noteTemplates = NOTE_TEMPLATES;

    @api
    get deal() {
        return this._deal;
    }
    set deal(value) {
        const changed = !this._deal || !value || this._deal.id !== value.id;
        this._deal = value;
        if (changed && value) {
            this.resetForms();
            this.loadInsights();
        }
    }

    connectedCallback() {
        this._keyHandler = (e) => {
            if (e.key === 'Escape') {
                this.handleClose();
            }
        };
        window.addEventListener('keydown', this._keyHandler);
    }

    disconnectedCallback() {
        window.removeEventListener('keydown', this._keyHandler);
    }

    resetForms() {
        this.note = '';
        this.taskSubject = '';
        this.taskComments = '';
        this.taskPriority = 'Normal';
        const due = new Date();
        due.setDate(due.getDate() + 2);
        this.taskDue = toIsoDate(due);
    }

    async loadInsights() {
        const id = this._deal && this._deal.id;
        if (!id) {
            return;
        }
        this.loadingInsights = true;
        try {
            const result = await getDealInsights({ opportunityId: id });
            if (this._deal && this._deal.id === id) {
                this.insights = result;
            }
        } catch (error) {
            this.toast('Could not load activity', reduceErrors(error), 'error');
        } finally {
            this.loadingInsights = false;
        }
    }

    // ---- view helpers

    get recordId() {
        return this._deal && this._deal.id;
    }

    get facts() {
        const d = this._deal;
        if (!d) {
            return [];
        }
        const money = (v) => (v ? formatCompactCurrency(v, CURRENCY, LOCALE) : '—');
        return [
            { key: 'amount', label: 'Amount', value: money(d.amount) },
            { key: 'weighted', label: 'Weighted', value: money(d.weightedAmount) },
            {
                key: 'close',
                label: 'Close date',
                value: d.closeDate || '—',
                sub: d.closeLabel,
                className: d.isOverdue ? 'pcc-fact-sub pcc-fact-sub_bad' : 'pcc-fact-sub'
            },
            {
                key: 'activity',
                label: 'Last activity',
                value: d.lastActivityDate || 'None',
                sub: d.daysSinceActivity == null ? '' : `${d.daysSinceActivity}d ago`,
                className: 'pcc-fact-sub'
            },
            { key: 'stage', label: 'Days in stage', value: d.daysInStage == null ? '—' : `${d.daysInStage}` },
            { key: 'push', label: 'Close date pushes', value: `${d.pushCount || 0}` }
        ];
    }

    get posts() {
        return (this.insights.posts || []).map((p) => ({
            ...p,
            when: timeAgo(new Date(p.createdDate).getTime())
        }));
    }

    get hasPosts() {
        return this.posts.length > 0;
    }

    get tasks() {
        return (this.insights.tasks || []).map((t) => ({
            ...t,
            icon: t.isClosed ? 'utility:check' : t.isOverdue ? 'utility:warning' : 'utility:clock',
            iconVariant: t.isOverdue ? 'error' : t.isClosed ? 'success' : '',
            className: t.isClosed ? 'pcc-task pcc-task_done' : t.isOverdue ? 'pcc-task pcc-task_overdue' : 'pcc-task',
            meta: [t.dueDate, t.ownerName, t.status].filter(Boolean).join(' · ')
        }));
    }

    get hasTasks() {
        return this.tasks.length > 0;
    }

    get mentionHint() {
        return this._deal ? `Posts to the deal's Chatter feed and notifies ${this._deal.ownerName}.` : '';
    }

    get postDisabled() {
        return this.posting || !this.note.trim();
    }

    get taskDisabled() {
        return this.savingTask || !this.taskSubject.trim();
    }

    get taskHint() {
        return this._deal ? `Assigned to ${this._deal.ownerName}.` : '';
    }

    // ---- actions

    handleClose() {
        this.dispatchEvent(new CustomEvent('close'));
    }

    openRecord() {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId: this.recordId, objectApiName: 'Opportunity', actionName: 'view' }
        });
    }

    handleTab(event) {
        this.activeTab = event.target.value;
    }

    handleSaved() {
        this.toast('Deal updated', `${this._deal.name} was saved.`, 'success');
        this.dispatchEvent(new CustomEvent('dealsaved', { detail: { recordId: this.recordId } }));
    }

    handleFormError(event) {
        const detail = event.detail || {};
        this.toast('Could not save', detail.detail || detail.message || 'Check the highlighted fields.', 'error');
    }

    handleNoteChange(event) {
        this.note = event.target.value || '';
    }

    handleTemplate(event) {
        this.note = event.currentTarget.dataset.text;
    }

    async handlePost() {
        this.posting = true;
        try {
            await postCoachingNote({ opportunityId: this.recordId, message: this.note });
            this.note = '';
            this.toast('Note posted', `${this._deal.ownerName} has been notified.`, 'success');
            await this.loadInsights();
        } catch (error) {
            this.toast('Could not post note', reduceErrors(error), 'error');
        } finally {
            this.posting = false;
        }
    }

    handleTaskField(event) {
        const field = event.target.dataset.field;
        this[field] = event.detail && event.detail.value !== undefined ? event.detail.value : event.target.value;
    }

    async handleCreateTask() {
        this.savingTask = true;
        try {
            await createFollowUpTask({
                opportunityId: this.recordId,
                subject: this.taskSubject,
                dueDate: this.taskDue,
                priority: this.taskPriority,
                comments: this.taskComments
            });
            this.toast('Task assigned', `${this.taskSubject} → ${this._deal.ownerName}`, 'success');
            this.resetForms();
            await this.loadInsights();
            this.dispatchEvent(new CustomEvent('dealsaved', { detail: { recordId: this.recordId } }));
        } catch (error) {
            this.toast('Could not create task', reduceErrors(error), 'error');
        } finally {
            this.savingTask = false;
        }
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
