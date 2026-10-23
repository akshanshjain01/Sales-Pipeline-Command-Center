import LightningDatatable from 'lightning/datatable';
import dealTemplate from './dealCell.html';
import healthTemplate from './healthCell.html';
import picklistTemplate from './picklistCell.html';
import picklistEditTemplate from './picklistEdit.html';

/**
 * lightning-datatable with three extra column types:
 *  - deal:     clickable name that opens the side panel, plus a "live" tag
 *  - health:   score pill with the main risk reason
 *  - picklist: inline-editable picklist (used for Stage)
 */
export default class PipelineDatatable extends LightningDatatable {
    static customTypes = {
        deal: {
            template: dealTemplate,
            standardCellLayout: true,
            typeAttributes: ['recordId', 'liveLabel', 'isHighValue']
        },
        health: {
            template: healthTemplate,
            standardCellLayout: true,
            typeAttributes: ['level', 'flags']
        },
        picklist: {
            template: picklistTemplate,
            editTemplate: picklistEditTemplate,
            standardCellLayout: true,
            typeAttributes: ['options', 'placeholder']
        }
    };
}
