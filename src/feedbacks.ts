import {
	combineRgb,
	type CompanionFeedbackDefinitions,
	type CompanionInputFieldNumber,
	type DropdownChoice,
} from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { BaseDevice, NexusState } from './nexus.js'
import { cellOption } from './options.js'
import { ANY_ERROR_CODE, ERROR_CODE_CHOICES } from './errors.js'

/**
 * Feedback ids. The values are the ids saved against every button using the feedback, so they must never change.
 * The first two predate this enum and are camelCase for that reason.
 */
export enum FeedbackId {
	Trap = 'xciSnmpTrap',
	TrapLatch = 'xciSnmpTrapLatch',
	DeviceHealth = 'device_health',
	SystemHealth = 'system_health',
	ErrorCount = 'error_count',
	SyncSource = 'sync_source',
}

export const DeviceProperty = [
	'online',
	'configBoards',
	'availBoards',
	'boardsOk',
	'powerUnits',
	'pwrGoodUnits',
	'powerOk',
	'cpuTemperature',
	'cpuMaxTemp',
] as const
export type DeviceProperty = (typeof DeviceProperty)[number]

export const SystemProperty = [
	'allDevicesOnline',
	'allBoardsOk',
	'allPowerOk',
	'maxCpuTemperature',
	'activeErrors',
] as const
export type SystemProperty = (typeof SystemProperty)[number]

/** null for anything not read from the XCI yet, or that it doesn't report */
export type HealthResult = number | boolean | null

export type FeedbackSchema = {
	[FeedbackId.Trap]: { type: 'boolean'; options: { cell: number } }
	[FeedbackId.TrapLatch]: { type: 'boolean'; options: { cell: number } }
	[FeedbackId.DeviceHealth]: {
		type: 'value'
		options: { device: number; property: DeviceProperty }
		result: HealthResult
	}
	[FeedbackId.SystemHealth]: { type: 'value'; options: { property: SystemProperty }; result: HealthResult }
	/** `code` is a listed code's number, or the text of a code typed in that isn't listed */
	[FeedbackId.ErrorCount]: { type: 'value'; options: { node: number; code: number | string }; result: number }
	[FeedbackId.SyncSource]: { type: 'boolean'; options: { source: number } }
}

const DEVICE_PROPERTY_CHOICES = [
	{ id: 'online', label: 'Online' },
	{ id: 'configBoards', label: 'Configured boards' },
	{ id: 'availBoards', label: 'Available boards' },
	{ id: 'boardsOk', label: 'Every configured board available' },
	{ id: 'powerUnits', label: 'Power units' },
	{ id: 'pwrGoodUnits', label: 'Working power units' },
	{ id: 'powerOk', label: 'Every power unit working' },
	{ id: 'cpuTemperature', label: 'CPU temperature (°C)' },
	{ id: 'cpuMaxTemp', label: 'CPU max temperature since cold boot (°C)' },
] as const satisfies DropdownChoice<DeviceProperty>[]

const SYSTEM_PROPERTY_CHOICES = [
	{ id: 'allDevicesOnline', label: 'Every base device online' },
	{ id: 'allBoardsOk', label: 'Every configured board available' },
	{ id: 'allPowerOk', label: 'Every power unit working' },
	{ id: 'maxCpuTemperature', label: 'Hottest CPU temperature (°C)' },
	{ id: 'activeErrors', label: 'Active errors' },
] as const satisfies DropdownChoice<SystemProperty>[]

const defaultStyle = {
	bgcolor: combineRgb(255, 0, 0),
	color: combineRgb(0, 0, 0),
}

const atLeast = (have: number | undefined, want: number | undefined): boolean | null =>
	have === undefined || want === undefined ? null : have >= want

export function deviceHealth(device: BaseDevice | undefined, property: DeviceProperty): HealthResult {
	if (!device) return null
	switch (property) {
		case 'online':
		case 'configBoards':
		case 'availBoards':
		case 'powerUnits':
		case 'pwrGoodUnits':
		case 'cpuTemperature':
		case 'cpuMaxTemp':
			return device[property] ?? null
		case 'boardsOk':
			return atLeast(device.availBoards, device.configBoards)
		case 'powerOk':
			return atLeast(device.pwrGoodUnits, device.powerUnits)
		default: {
			// A saved option this version no longer offers
			const unhandled: never = property
			void unhandled
			return null
		}
	}
}

/** Every device's value, or null if there are none or any isn't known */
function every(nexus: NexusState, property: DeviceProperty): boolean | null {
	const values = [...nexus.devices.values()].map((device) => deviceHealth(device, property))
	if (values.length === 0 || values.some((value) => value === null)) return null
	return values.every((value) => value === true)
}

export function systemHealth(nexus: NexusState, property: SystemProperty): HealthResult {
	switch (property) {
		case 'allDevicesOnline': {
			const { baseDevNum, baseDevOnline } = nexus.scalars
			return atLeast(baseDevOnline, baseDevNum)
		}
		case 'allBoardsOk':
			return every(nexus, 'boardsOk')
		case 'allPowerOk':
			return every(nexus, 'powerOk')
		case 'maxCpuTemperature': {
			const temperatures = [...nexus.devices.values()]
				.map(({ cpuTemperature }) => cpuTemperature)
				.filter((value) => value !== undefined)
			return temperatures.length === 0 ? null : Math.max(...temperatures)
		}
		case 'activeErrors':
			return nexus.errors.active.length
		default: {
			const unhandled: never = property
			void unhandled
			return null
		}
	}
}

/** The largest an option may be where nothing narrower is known: the MIB's PositiveInteger maximum */
export const MAX_INTEGER = 2147483647

/** A number option where 0 means any */
function anyOption<TKey extends string>(id: TKey, label: string, tooltip: string): CompanionInputFieldNumber<TKey> {
	return { id, type: 'number', label, default: 0, min: 0, max: MAX_INTEGER, step: 1, tooltip, asInteger: true }
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const feedbacks: CompanionFeedbackDefinitions<FeedbackSchema> = {
		[FeedbackId.Trap]: {
			name: 'XCI SNMP Trap',
			description: 'Follows the state of the logic cell, as last reported by a trap',
			type: 'boolean',
			defaultStyle,
			options: [cellOption()],
			callback: ({ id, options }) => {
				const cell = Math.floor(options.cell)
				// Before the range check in cells.get, so a feedback whose cell is changed to one out of range stops
				// watching the one it had
				self.trapFeedbacks.subscribe(id, cell)
				return self.cells.get(cell).value
			},
			unsubscribe: ({ id }) => self.trapFeedbacks.unsubscribe(id),
		},
		[FeedbackId.TrapLatch]: {
			name: 'XCI SNMP Trap - Latched',
			description: 'Goes true when a trap reports the logic cell true, and stays true until reset',
			type: 'boolean',
			defaultStyle,
			options: [cellOption()],
			callback: ({ id, options }) => {
				const cell = Math.floor(options.cell)
				self.latchFeedbacks.subscribe(id, cell)
				return self.cells.get(cell).latch
			},
			unsubscribe: ({ id }) => self.latchFeedbacks.unsubscribe(id),
		},
		[FeedbackId.DeviceHealth]: {
			name: 'Base Device Health',
			description:
				"A value from a base device's row of the MIB's baseDevTable. Empty until read, or for an unknown device",
			type: 'value',
			options: [
				{
					id: 'device',
					type: 'number',
					label: 'Base Device',
					default: 1,
					min: 1,
					// Wide until the XCI has been read: a narrow limit would put an error on every saved feedback for a
					// higher device until then. The instance sets the definitions again when it changes
					max: self.nexus.deviceLimit ?? MAX_INTEGER,
					step: 1,
					tooltip: 'The base device node number. The Base Device variables show which there are',
					asInteger: true,
				},
				{
					id: 'property',
					type: 'dropdown',
					label: 'Value',
					choices: DEVICE_PROPERTY_CHOICES,
					default: DEVICE_PROPERTY_CHOICES[0].id,
				},
			],
			callback: ({ options }) => deviceHealth(self.nexus.devices.get(Math.floor(options.device)), options.property),
		},
		[FeedbackId.SystemHealth]: {
			name: 'System Health',
			description: 'A value across every base device, or the number of active errors. Empty until read',
			type: 'value',
			options: [
				{
					id: 'property',
					type: 'dropdown',
					label: 'Value',
					choices: SYSTEM_PROPERTY_CHOICES,
					default: SYSTEM_PROPERTY_CHOICES[0].id,
				},
			],
			callback: ({ options }) => systemHealth(self.nexus, options.property),
		},
		[FeedbackId.ErrorCount]: {
			name: 'Active Errors',
			description: 'The number of active Nexus errors, optionally only from one node or with one code',
			type: 'value',
			options: [
				anyOption('node', 'Node', 'Only errors from this node. 0 for any'),
				{
					id: 'code',
					type: 'dropdown',
					label: 'Error Code',
					choices: ERROR_CODE_CHOICES,
					default: ANY_ERROR_CODE,
					// A code the list doesn't have can be typed in. Companion passes it on as text
					allowCustom: true,
					regex: '/^\\d+$/',
					tooltip: 'Only errors with this code. Any for every code',
				},
			],
			callback: ({ options }) =>
				self.nexus.errors.count({ node: Math.floor(options.node), code: Number(options.code) }),
		},
		[FeedbackId.SyncSource]: {
			name: 'Sync Source',
			description: 'True while the Nexus is synced to this source',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(0, 204, 0), color: combineRgb(0, 0, 0) },
			options: [
				{
					id: 'source',
					type: 'number',
					label: 'Sync Source',
					default: 0,
					min: 0,
					max: MAX_INTEGER,
					step: 1,
					tooltip: '0 for the internal clock',
					asInteger: true,
				},
			],
			callback: ({ options }) => self.nexus.scalars.syncIndex === Math.floor(options.source),
		},
	}
	self.setFeedbackDefinitions(feedbacks)
}
