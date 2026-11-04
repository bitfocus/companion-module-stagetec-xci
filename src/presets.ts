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

/** The CPU temperature gauge's range, in °C */
export const TEMPERATURE = { min: 20, max: 100 } as const

/**
 * The CPU temperature at which Nexus Service warns, in °C. Base devices are taken to have an XCPU, which warns at 55°C
 * from its air temperature sensor. baseDevTable doesn't say which CPU card a device has: one with an XCI warns at 80°C
 * from its FPGA sensor, and the warning temperature is a local variable that can be set to that on its button
 */
export const XCPU_WARNING = 55
export const XCI_WARNING = 80

/** The preset's local variable holding the warning temperature, {@link XCPU_WARNING} to start with */
export const WARNING_VARIABLE = 'warnTemperature'
const WARNING = `$(local:${WARNING_VARIABLE})`

/** True once the CPU has reached the warning temperature. False while it hasn't been read */
const HOT = `(${local('cpuTemperature')} !== null && ${local('cpuTemperature')} >= ${WARNING})`

/**
 * Red when offline, amber when online with a board missing, a power unit failed or the CPU at its warning temperature,
 * green when all is well, and grey until the device has been read. A value the XCI doesn't give is null, so only
 * === true and === false count
 */
export const BACKGROUND_EXPRESSION = [
	`${local('online')} === false ? '${COLORS.offline}'`,
	`: ${local('online')} === true && (${local('boardsOk')} === false || ${local('powerOk')} === false || ${HOT}) ? '${COLORS.degraded}'`,
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

/** How far either side of the warning temperature the gauge turns yellow, then red, in °C */
export const WARNING_BAND = 10

/**
 * The gauge's colour bands. Each starts at its `from`, an expression of the warning temperature so the bands follow
 * `warnTemperature`, and runs to the next. With an XCPU's 55°C: green to 45, yellow to 55, amber to 65, red above
 */
export const GAUGE_BANDS = [
	{ name: 'normal', from: String(TEMPERATURE.min), color: '#43a047' },
	{ name: 'approaching', from: `${WARNING} - ${WARNING_BAND}`, color: '#fdd835' },
	{ name: 'warning', from: WARNING, color: '#fb8c00' },
	{ name: 'over', from: `${WARNING} + ${WARNING_BAND}`, color: '#e53935' },
] as const

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
		notes: [
			`Change the "${DEVICE_VARIABLE}" local variable to show another base device.`,
			`"${WARNING_VARIABLE}" is the CPU temperature that turns the button amber: ${XCPU_WARNING} for an XCPU,`,
			`or set it to ${XCI_WARNING} for a base device with an XCI.`,
		].join(' '),
		localVariables: [
			{ variableType: 'simple', variableName: DEVICE_VARIABLE, startupValue: 1 },
			{ variableType: 'simple', variableName: WARNING_VARIABLE, startupValue: XCPU_WARNING },
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
				// One colour for the whole fill, the band the temperature is in, so the bar flips as it crosses each.
				// Companion takes the colour of the highest stop at or below the value
				multiColour: false,
				stops: GAUGE_BANDS.map(({ name, from, color }) => ({
					value: name === 'normal' ? TEMPERATURE.min : { isExpression: true, value: from },
					color,
					gradient: false,
				})),
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
					description: `Amber from ${XCPU_WARNING}°C, the XCPU warning temperature in Nexus Service`,
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
		{ id: 'health', name: 'Health', definitions: [group], keywords: ['health', 'base device', 'xcpu'] },
	]
	const presets: CompanionPresetDefinitions<ModuleTypes> = {
		[PresetId.BaseDeviceHealth]: baseDeviceHealthPreset(),
	}
	self.setPresetDefinitions(structure, presets)
}
