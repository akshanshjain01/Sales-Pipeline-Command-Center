import { createElement } from 'lwc';
import PipelineCommandCenter from 'c/pipelineCommandCenter';
import getPipeline from '@salesforce/apex/PipelineCommandCenterController.getPipeline';
import getChanges from '@salesforce/apex/PipelineCommandCenterController.getChanges';

jest.mock(
    '@salesforce/apex/PipelineCommandCenterController.getPipeline',
    () => ({ default: jest.fn() }),
    { virtual: true }
);
jest.mock(
    '@salesforce/apex/PipelineCommandCenterController.getChanges',
    () => ({ default: jest.fn() }),
    { virtual: true }
);
jest.mock(
    '@salesforce/apex/PipelineCommandCenterController.getDealInsights',
    () => ({ default: jest.fn(() => Promise.resolve({ posts: [], tasks: [] })) }),
    { virtual: true }
);
jest.mock(
    '@salesforce/apex/PipelineCommandCenterController.postCoachingNote',
    () => ({ default: jest.fn() }),
    { virtual: true }
);
jest.mock(
    '@salesforce/apex/PipelineCommandCenterController.createFollowUpTask',
    () => ({ default: jest.fn() }),
    { virtual: true }
);

const today = new Date();
const iso = (offsetDays) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const STAGES = [
    { label: 'Prospecting', value: 'Prospecting', isClosed: false, isWon: false, probability: 10 },
    { label: 'Negotiation/Review', value: 'Negotiation/Review', isClosed: false, isWon: false, probability: 90 },
    { label: 'Closed Won', value: 'Closed Won', isClosed: true, isWon: true, probability: 100 },
    { label: 'Closed Lost', value: 'Closed Lost', isClosed: true, isWon: false, probability: 0 }
];

const deal = (o) => ({
    name: 'Deal',
    accountName: 'Acme',
    ownerId: '005A',
    ownerName: 'Maya Patel',
    stageName: 'Prospecting',
    amount: 20000,
    probability: 10,
    closeDate: iso(20),
    nextStep: 'Call',
    isClosed: false,
    isWon: false,
    healthScore: 100,
    healthLevel: 'healthy',
    riskFlags: [],
    lastModifiedDate: '2026-10-22T10:00:00.000Z',
    ...o
});

const DATA = {
    stages: STAGES,
    hasTeam: true,
    truncated: false,
    maxRecords: 2000,
    currentUserId: '005ME',
    serverTime: '2026-10-22T10:00:00.000Z',
    deals: [
        deal({ id: '006A', name: 'Northwind - Platform', amount: 300000 }),
        deal({
            id: '006B',
            name: 'Bluepeak - Renewal',
            stageName: 'Negotiation/Review',
            closeDate: iso(-3),
            healthScore: 40,
            healthLevel: 'risk',
            riskFlags: [{ code: 'OVERDUE', label: 'Close date passed 3d ago', severity: 'high', penalty: 30 }]
        }),
        deal({ id: '006C', name: 'Crestline - Pilot', stageName: 'Closed Won', isClosed: true, isWon: true, healthLevel: 'closed' })
    ]
};

// eslint-disable-next-line @lwc/lwc/no-async-operation
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('c-pipeline-command-center', () => {
    beforeEach(() => {
        window.localStorage.clear();
        getPipeline.mockResolvedValue(DATA);
        getChanges.mockResolvedValue({ deals: [], serverTime: DATA.serverTime });
    });

    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        jest.clearAllMocks();
    });

    async function render() {
        const el = createElement('c-pipeline-command-center', { is: PipelineCommandCenter });
        document.body.appendChild(el);
        await flush();
        await flush();
        return el;
    }

    it('loads the team pipeline and shows KPIs and the list', async () => {
        const el = await render();
        expect(getPipeline).toHaveBeenCalledWith({ scope: 'TEAM', staleDays: 14 });

        const summary = el.shadowRoot.querySelector('c-pipeline-summary');
        expect(summary.kpis.openCount).toBe(2);
        expect(summary.kpis.atRiskCount).toBe(1);
        expect(summary.kpis.wonCount).toBe(1);

        const table = el.shadowRoot.querySelector('c-pipeline-datatable');
        expect(table.data.map((r) => r.id)).toEqual(['006B', '006A']); // open only, soonest close first
    });

    it('applies a KPI tile as a filter', async () => {
        const el = await render();
        el.shadowRoot
            .querySelector('c-pipeline-summary')
            .dispatchEvent(new CustomEvent('tileselect', { detail: { key: 'atRisk' } }));
        await flush();
        expect(el.shadowRoot.querySelector('c-pipeline-datatable').data.map((r) => r.id)).toEqual(['006B']);
    });

    it('switches to the Kanban board and remembers the choice', async () => {
        const el = await render();
        el.shadowRoot.querySelector('lightning-button-icon[data-view="kanban"]').click();
        await flush();
        const board = el.shadowRoot.querySelector('c-pipeline-kanban');
        expect(board).not.toBeNull();
        expect(board.deals).toHaveLength(2);
        expect(JSON.parse(window.localStorage.getItem('pcc.prefs.v1')).view).toBe('kanban');
    });

    it('opens the deal panel when a deal is selected', async () => {
        const el = await render();
        el.shadowRoot
            .querySelector('c-pipeline-datatable')
            .dispatchEvent(new CustomEvent('dealselect', { detail: { recordId: '006A' }, bubbles: true }));
        await flush();
        const panel = el.shadowRoot.querySelector('c-pipeline-deal-panel');
        expect(panel).not.toBeNull();
        expect(panel.deal.name).toBe('Northwind - Platform');
    });

    it('shows an error with a retry when loading fails', async () => {
        getPipeline.mockRejectedValue({ body: { message: 'Insufficient access' } });
        const el = await render();
        expect(el.shadowRoot.querySelector('.slds-alert_error').textContent).toContain('Insufficient access');
    });
});
