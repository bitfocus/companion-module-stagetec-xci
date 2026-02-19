export const checkCellValue = (cell) => {
	if (isNaN(cell) || cell < 1 || cell > 256) {
		throw new Error(`Invalid Cell! ${cell} should be a number between 1 and 256`)
	}
}

export default function (self) {
	self.setActionDefinitions({
		resetLatch: {
			name: 'Reset Latch',
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
					isVisibleExpression: '!($(options:useVar) || $(options:all))',
				},
				{
					id: 'cellVar',
					type: 'textinput',
					label: 'Logic Cell',
					useVariables: { local: true },
					tooltip: 'Variable must return an integer between 1 and 256',
					isVisibleExpression: '$(options:useVar) && !$(options:all)',
				},
				{
					id: 'useVar',
					type: 'checkbox',
					label: 'Use Variable',
					default: false,
					isVisibleExpression: '!$(options:all)',
				},
				{
					id: 'all',
					type: 'checkbox',
					label: 'Reset All',
					default: false,
					isVisibleExpression: '!$(options:useVar)',
				},
			],
			callback: async (action) => {
				let varList = []
				if (action.options.all) {
					for (let i = 1; i <= 256; i++) {
						self.logicCell[i].latch = false
						varList[`cellLatch_${i}`] = self.logicCell[i].latch
					}
					self.log('debug', 'Resetting all latches')
					self.setVariableValues(varList)
					self.checkFeedbacks('xciSnmpTrapLatch')
					return
				}
				const cell = action.options.useVar ? parseInt(action.options.cellVar) : Math.floor(action.options.cell)
				checkCellValue(cell)
				self.logicCell[cell].latch = false
				self.log('debug', `Resetting latch ${cell}`)
				varList[`cellLatch_${cell}`] = self.logicCell[cell].latch
				self.checkFeedbacks('xciSnmpTrapLatch')
				self.setVariableValues(varList)
			},
		},
		resetCount: {
			name: 'Reset Count',
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
					isVisibleExpression: '!($(options:useVar) || $(options:all))',
				},
				{
					id: 'cellVar',
					type: 'textinput',
					label: 'Logic Cell',
					useVariables: { local: true },
					tooltip: 'Variable must return an integer between 1 and 256',
					isVisibleExpression: '$(options:useVar) && !$(options:all)',
				},
				{
					id: 'useVar',
					type: 'checkbox',
					label: 'Use Variable',
					default: false,
					isVisibleExpression: '!$(options:all)',
				},
				{
					id: 'all',
					type: 'checkbox',
					label: 'Reset All',
					default: false,
					isVisibleExpression: '!$(options:useVar)',
				},
			],
			callback: async (action) => {
				let varList = []
				if (action.options.all) {
					for (let i = 1; i <= 256; i++) {
						self.logicCell[i].count = 0
						varList[`cellCount_${i}`] = self.logicCell[i].count
					}
					self.log('debug', 'Resetting all counts')
					self.setVariableValues(varList)
					return
				}
				const cell = action.options.useVar ? parseInt(action.options.cellVar) : Math.floor(action.options.cell)
				checkCellValue(cell)
				self.logicCell[cell].count = 0
				self.log('debug', `Resetting count ${cell}`)
				varList[`cellLatch_${cell}`] = self.logicCell[cell].latch
				self.setVariableValues(varList)
			},
		},
	})
}
