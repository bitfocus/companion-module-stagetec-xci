import type {
	CompanionLayeredButtonPresetDefinition,
	CompanionPresetDefinitions,
	CompanionPresetGroup,
	CompanionPresetLocalVariable,
	CompanionPresetSection,
} from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleTypes } from './main.js'
import { FeedbackId, type DeviceProperty, type FeedbackSchema } from './feedbacks.js'

export enum PresetId {
	BaseDeviceHealth = 'base_device_health',
}

/** The preset's local variable naming its base device. The template group sets it per device */
export const DEVICE_VARIABLE = 'device'
const DEVICE = { isExpression: true, value: `$(local:${DEVICE_VARIABLE})` } as const

/** The Base Device Health values the preset shows, each in a local variable of the same name */
export const HEALTH_VARIABLES = [
	'online',
	'boardsOk',
	'powerOk',
	'availBoards',
	'configBoards',
	'pwrGoodUnits',
	'powerUnits',
	'cpuTemperature',
] as const satisfies DeviceProperty[]

const local = (name: (typeof HEALTH_VARIABLES)[number]): string => `$(local:${name})`

export const COLORS = {
	ok: '#1b5e20',
	degraded: '#b26a00',
	offline: '#b71c1c',
	unknown: '#424242',
	text: '#ffffff',
} as const

/** The CPU temperature gauge's range, and where it turns amber and red, in °C */
export const TEMPERATURE = { min: 20, max: 90, warm: 60, hot: 75 } as const

/**
 * Red when offline, amber when online with a board missing or a power unit failed, green when all is well, and grey
 * until the device has been read. A value the XCI doesn't give is null, so only === true and === false count
 */
export const BACKGROUND_EXPRESSION = [
	`${local('online')} === false ? '${COLORS.offline}'`,
	`: ${local('online')} === true && (${local('boardsOk')} === false || ${local('powerOk')} === false) ? '${COLORS.degraded}'`,
	`: ${local('online')} === true ? '${COLORS.ok}'`,
	`: '${COLORS.unknown}'`,
].join(' ')

export const STATUS_EXPRESSION = `${local('online')} === true ? 'Online' : ${local('online')} === false ? 'OFFLINE' : '-'`

/** eg "Boards 7/8", with "-" for a count not read */
const countExpression = (label: string, have: string, of: string): string =>
	`'${label} ' + (${have} ?? '-') + '/' + (${of} ?? '-')`

export const BOARDS_EXPRESSION = countExpression('Boards', local('availBoards'), local('configBoards'))
export const POWER_EXPRESSION = countExpression('PSU', local('pwrGoodUnits'), local('powerUnits'))
export const TEMPERATURE_EXPRESSION = `'CPU ' + (${local('cpuTemperature')} ?? '-') + '°C'`
export const TITLE_EXPRESSION = `'Device ' + $(local:${DEVICE_VARIABLE})`
/** The gauge sits empty until the temperature has been read */
export const GAUGE_EXPRESSION = `${local('cpuTemperature')} ?? ${TEMPERATURE.min}`

const text = (y: number, height: number, value: string, fontsize: number) =>
	({
		type: 'text',
		x: 2,
		y,
		width: 96,
		height,
		text: { isExpression: true, value },
		fontsize,
		fontsizeAllowShrink: true,
		color: COLORS.text,
		halign: 'center',
		valign: 'center',
	}) as const

/**
 * A base device's health on one button: online, boards and power units against what is configured, and the CPU
 * temperature as a gauge. Everything comes from the Base Device Health value feedback, for the device named by the
 * `device` local variable, so the one preset serves every device.
 */
export function baseDeviceHealthPreset(): CompanionLayeredButtonPresetDefinition<ModuleTypes> {
	return {
		type: 'layered',
		name: 'Base Device Health',
		keywords: ['health', 'base device', 'online', 'boards', 'power', 'psu', 'temperature', 'cpu'],
		notes: `Change the "${DEVICE_VARIABLE}" local variable to show another base device`,
		localVariables: [
			{ variableType: 'simple', variableName: DEVICE_VARIABLE, startupValue: 1 },
			...HEALTH_VARIABLES.map((property): CompanionPresetLocalVariable<FeedbackSchema> => ({
				variableType: 'feedback',
				variableName: property,
				feedbackId: FeedbackId.DeviceHealth,
				options: { device: DEVICE, property },
			})),
		],
		elements: [
			{
				type: 'box',
				id: 'background',
				name: 'Background',
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				color: { isExpression: true, value: BACKGROUND_EXPRESSION },
			},
			{
				...text(0, 22, TITLE_EXPRESSION, 20),
				id: 'title',
				name: 'Device',
				weight: 'bold',
			},
			{ ...text(22, 18, STATUS_EXPRESSION, 16), id: 'status', name: 'Online' },
			{ ...text(40, 16, BOARDS_EXPRESSION, 14), id: 'boards', name: 'Boards' },
			{ ...text(56, 16, POWER_EXPRESSION, 14), id: 'power', name: 'Power Units' },
			{ ...text(72, 14, TEMPERATURE_EXPRESSION, 13), id: 'temperature', name: 'CPU Temperature' },
			{
				type: 'gauge',
				id: 'temperature_gauge',
				name: 'CPU Temperature Gauge',
				x: 6,
				y: 88,
				width: 88,
				height: 8,
				orientation: 'horizontal',
				value: { isExpression: true, value: GAUGE_EXPRESSION },
				min: TEMPERATURE.min,
				max: TEMPERATURE.max,
				// One colour for the whole fill, the stop at or below the temperature, rather than a gradient along it
				multiColour: false,
				stops: [
					{ value: TEMPERATURE.min, color: '#43a047', gradient: false },
					{ value: TEMPERATURE.warm, color: '#ffb300', gradient: false },
					{ value: TEMPERATURE.hot, color: '#e53935', gradient: false },
				],
				trackStyle: 'dimmed',
			},
		],
		feedbacks: [],
		steps: [{ down: [], up: [] }],
	}
}

export function UpdatePresets(self: ModuleInstance): void {
	const devices = [...self.nexus.devices.keys()]
	// Until the XCI has been read there are no devices to list, so offer the preset on its own, for device 1
	const group: CompanionPresetGroup<ModuleTypes> =
		devices.length > 0
			? {
					id: 'base_devices',
					type: 'template',
					name: 'Base Devices',
					presetId: PresetId.BaseDeviceHealth,
					templateVariableName: DEVICE_VARIABLE,
					templateValues: devices.map((device) => ({ name: `Base Device ${device}`, value: device })),
				}
			: {
					id: 'base_devices',
					type: 'simple',
					name: 'Base Devices',
					description: 'Read from the XCI once connected. Until then, set the device local variable by hand',
					presets: [PresetId.BaseDeviceHealth],
				}
	const structure: CompanionPresetSection<ModuleTypes>[] = [
		{ id: 'health', name: 'Health', definitions: [group], keywords: ['health', 'base device'] },
	]
	const presets: CompanionPresetDefinitions<ModuleTypes> = {
		[PresetId.BaseDeviceHealth]: baseDeviceHealthPreset(),
	}
	self.setPresetDefinitions(structure, presets)
}
