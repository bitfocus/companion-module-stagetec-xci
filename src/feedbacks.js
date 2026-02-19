import { combineRgb } from '@companion-module/base'
import { checkCellValue } from './actions.js'

export default async function (self) {
	self.setFeedbackDefinitions({
		xciSnmpTrap: {
			name: 'XCI SNMP Trap',
			type: 'boolean',
			label: 'SNMP Trap from XCI',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [
				{
					id: 'cell',
					type: 'number',
					label: 'Logic Cell',
					default: 1,
					min: 1,
					max: 256,
					range: true,
					step: 1,
					tooltip: 'Refer to Nexus Service for Logic Cell number',
					isVisibleExpression: '!$(options:useVar)',
				},
				{
					id: 'cellVar',
					type: 'textinput',
					label: 'Logic Cell',
					default: '',
					useVariables: { local: true },
					tooltip: 'Variable must return an integer between 1 and 256',
					isVisibleExpression: '$(options:useVar)',
				},
				{
					id: 'useVar',
					type: 'checkbox',
					label: 'Use Variable',
					default: false,
				},
			],
			callback: async (feedback) => {
				const cell = feedback.options.useVar ? parseInt(feedback.options.cellVar) : Math.floor(feedback.options.cell)
				checkCellValue(cell)
				return self.logicCell[cell].value
			},
		},
		xciSnmpTrapLatch: {
			name: 'XCI SNMP Trap - Latched',
			type: 'boolean',
			label: 'SNMP Trap from XCI - Latched',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [
				{
					id: 'cell',
					type: 'number',
					label: 'Logic Cell',
					default: 1,
					min: 1,
					max: 256,
					range: true,
					step: 1,
					tooltip: 'Refer to Nexus Service for Logic Cell number',
					isVisibleExpression: '!$(options:useVar)',
				},
				{
					id: 'cellVar',
					type: 'textinput',
					label: 'Logic Cell',
					default: '',
					useVariables: { local: true },
					tooltip: 'Variable must return an integer between 1 and 256',
					isVisibleExpression: '$(options:useVar)',
				},
				{
					id: 'useVar',
					type: 'checkbox',
					label: 'Use Variable',
					default: false,
				},
			],
			callback: async (feedback) => {
				const cell = feedback.options.useVar ? parseInt(feedback.options.cellVar) : Math.floor(feedback.options.cell)
				checkCellValue(cell)
				return self.logicCell[cell].latch
			},
		},
	})
}
