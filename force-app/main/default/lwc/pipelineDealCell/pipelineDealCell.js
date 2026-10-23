import { LightningElement, api } from 'lwc';

/**
 * Deal name inside the datatable. Clicking it opens the side panel
 * (the event bubbles out of the datatable to the command center).
 */
export default class PipelineDealCell extends LightningElement {
    @api recordId;
    @api name;
    @api liveLabel;
    @api isHighValue = false;

    handleClick(event) {
        event.preventDefault();
        this.dispatchEvent(
            new CustomEvent('dealselect', {
                detail: { recordId: this.recordId },
                bubbles: true,
                composed: true
            })
        );
    }
}
