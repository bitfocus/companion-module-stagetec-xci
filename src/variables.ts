import type { CompanionVariableDefinitions } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { Scalars } from './mib.js'
import type { BaseDevice, NexusState } from './nexus.js'
import { CELL_COUNT, type LogicCells } from './xci.js'

/** The variables each base device gets, by the BaseDevice field each shows. Named as the MIB's columns */
const DEVICE_VARIABLES = {
	online: { prefix: 'deviceOnline', name: 'Online' },
	configBoards: { prefix: 'configBoards', name: 'Configured Boards' },
	availBoards: { prefix: 'availBoards', name: 'Available Boards' },
	powerUnits: { prefix: 'powerUnits', name: 'Power Units' },
	pwrGoodUnits: { prefix: 'pwrGoodUnits', name: 'Working Power Units' },
	cpuTemperature: { prefix: 'cpuTemperature', name: 'CPU Temperature' },
	cpuMaxTemp: { prefix: 'cpuMaxTemp', name: 'CPU Max Temperature' },
} as const satisfies { [K in keyof BaseDevice]-?: { prefix: string; name: string } }

type DeviceVariables = {
	[K in keyof typeof DEVICE_VARIABLES as `${(typeof DEVICE_VARIABLES)[K]['prefix']}_${number}`]:
		BaseDevice[K] | undefined
}

/** The scalars, named as in the MIB, and what each is called in Companion */
const SCALAR_VARIABLES: { [K in keyof Scalars]: string } = {
	projectName: 'Project Name',
	projectRevision: 'Firmware Revision',
	baseDevNum: 'Base Devices Configured',
	baseDevOnline: 'Base Devices Online',
	syncSources: 'Sync Sources',
	syncIndex: 'Sync Source (0 = internal)',
	hostName: 'XCI Host Name',
	deviceType: 'XCI Device Type',
	moduleName: 'XCI MIB Module Name',
	moduleVersion: 'XCI MIB Module Version',
	firstSignal: 'First Configured Logic Signal',
	configSignals: 'Configured Logic Signals',
	trapSignals: 'Logic Signals With Traps',
	trapDestinations: 'Trap Destinations',
	trapDestAuto: 'Trap Destinations Found Automatically',
	trapTimeout: 'Trap Timeout',
}

type StatusVariables = { [K in keyof Scalars]: Scalars[K] | undefined } & {
	/** The trap destinations, comma separated */
	trapAddresses: string
	activeErrors: number
	/** The active errors' names, comma separated */
	activeErrorNames: string
	lastErrorNode: number | undefined
	lastErrorCode: number | undefined
	lastErrorName: string | undefined
	lastErrorParam: string | undefined
}

export type VariablesSchema = {
	[K in `cellLatch_${number}`]: boolean
} & {
	[K in `cellCount_${number}`]: number
} & {
	mostRecent: number
} & StatusVariables &
	DeviceVariables

export const latchVariable = (cell: number): `cellLatch_${number}` => `cellLatch_${cell}`
export const countVariable = (cell: number): `cellCount_${number}` => `cellCount_${cell}`

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const definitions: CompanionVariableDefinitions<VariablesSchema> = {
		mostRecent: { name: 'Most Recent Trigger' },
		...(Object.fromEntries(
			Object.entries(SCALAR_VARIABLES).map(([id, name]) => [id, { name }]),
		) as CompanionVariableDefinitions<StatusVariables>),
		trapAddresses: { name: 'Trap Destination Addresses' },
		activeErrors: { name: 'Active Errors' },
		activeErrorNames: { name: 'Active Error Names' },
		lastErrorNode: { name: 'Last Error Node' },
		lastErrorCode: { name: 'Last Error Code' },
		lastErrorName: { name: 'Last Error Name' },
		lastErrorParam: { name: 'Last Error Parameter' },
	}
	for (let cell = 1; cell <= CELL_COUNT; cell++) {
		definitions[latchVariable(cell)] = { name: `Logic Cell Latch ${cell}` }
		definitions[countVariable(cell)] = { name: `Logic Cell Count ${cell}` }
	}
	for (const device of self.nexus.devices.keys()) {
		for (const { prefix, name } of Object.values(DEVICE_VARIABLES)) {
			;(definitions as Record<string, { name: string }>)[`${prefix}_${device}`] = {
				name: `Base Device ${device} ${name}`,
			}
		}
	}
	self.setVariableDefinitions(definitions)
}

/** The values of every logic cell variable */
export function AllVariableValues(cells: LogicCells): Partial<VariablesSchema> {
	const values: Partial<VariablesSchema> = { mostRecent: cells.mostRecent }
	for (let cell = 1; cell <= CELL_COUNT; cell++) {
		const { latch, count } = cells.get(cell)
		values[latchVariable(cell)] = latch
		values[countVariable(cell)] = count
	}
	return values
}

/** The values of every status variable, undefined for anything not read */
export function StatusVariableValues(nexus: NexusState): Partial<VariablesSchema> {
	const { last, active } = nexus.errors
	const values: Record<string, unknown> = {
		...Object.fromEntries(Object.keys(SCALAR_VARIABLES).map((id) => [id, nexus.scalars[id as keyof Scalars]])),
		trapAddresses: nexus.trapAddresses.join(', '),
		activeErrors: active.length,
		activeErrorNames: active.map(({ name }) => name).join(', '),
		lastErrorNode: last?.node,
		lastErrorCode: last?.code,
		lastErrorName: last?.name,
		lastErrorParam: last?.param,
	}
	for (const [device, row] of nexus.devices) {
		for (const [field, { prefix }] of Object.entries(DEVICE_VARIABLES)) {
			values[`${prefix}_${device}`] = row[field as keyof BaseDevice]
		}
	}
	return values as Partial<VariablesSchema>
}
