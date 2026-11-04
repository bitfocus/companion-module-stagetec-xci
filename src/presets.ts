import {
	ButtonGraphicsDecorationType,
	type CompanionLayeredButtonPresetDefinition,
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionPresetLocalVariable,
	type CompanionPresetSection,
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
	ok: '#43a047',
	degraded: '#fb8c00',
	offline: '#e53935',
	unknown: '#757575',
	text: '#ffffff',
	background: '#000000',
} as const

/**
 * How bright the unlit part of the gauge is, as a percentage of its band colours. Companion's default of 70 left the
 * track too close to the fill to tell them apart
 */
export const GAUGE_TRACK_AMOUNT = 25

/** The bottom of the CPU temperature gauge, in °C. Its top follows the warning temperature, see GAUGE_MAX_EXPRESSION */
export const TEMPERATURE = { min: 20 } as const

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
 * The status light: red when offline, amber when online with a board missing, a power unit failed or the CPU at its
 * warning temperature, green when all is well, and grey until the device has been read. A value the XCI doesn't give
 * is null, so only === true and === false count
 */
export const STATUS_LIGHT_EXPRESSION = [
	`${local('online')} === false ? '${COLORS.offline}'`,
	`: ${local('online')} === true && (${local('boardsOk')} === false || ${local('powerOk')} === false || ${HOT}) ? '${COLORS.degraded}'`,
	`: ${local('online')} === true ? '${COLORS.ok}'`,
	`: '${COLORS.unknown}'`,
].join(' ')

export const STATUS_EXPRESSION = `${local('online')} === true ? 'Online' : ${local('online')} === false ? 'OFFLINE' : '-'`

/**
 * A Companion template string: the parts joined, between backticks. Companion's `+` only adds numbers, so
 * `'Boards ' + 7` is NaN: text is joined with a template string or concat() instead
 */
const templateString = (...parts: string[]): string => `\`${parts.join('')}\``
/** An expression's value inside a template string */
const interpolate = (expression: string): string => `\${${expression}}`
/** A value, or "-" until read */
const orDash = (variable: string): string => interpolate(`${variable} ?? '-'`)

/** eg "Boards 7/8", with "-" for a count not read */
const countExpression = (label: string, have: string, of: string): string =>
	templateString(`${label} `, orDash(have), '/', orDash(of))

export const BOARDS_EXPRESSION = countExpression('Boards', local('availBoards'), local('configBoards'))
export const POWER_EXPRESSION = countExpression('PSU', local('pwrGoodUnits'), local('powerUnits'))
export const TEMPERATURE_EXPRESSION = templateString('CPU ', orDash(local('cpuTemperature')), '°C')
export const TITLE_EXPRESSION = templateString('Device ', interpolate(`$(local:${DEVICE_VARIABLE})`))
/** The gauge sits empty until the temperature has been read */
export const GAUGE_EXPRESSION = `${local('cpuTemperature')} ?? ${TEMPERATURE.min}`

/** How far either side of the warning temperature the gauge turns yellow, then red, in °C */
export const WARNING_BAND = 10

/** How much red the gauge shows above where it turns red, in °C */
export const RED_BAND = 5

/**
 * The top of the gauge: the warning temperature, then 10°C of amber and 5°C of red. 70°C for an XCPU, and 95°C for a
 * button set to an XCI's 80°C. A fixed top would leave most of the bar red for one, or the warning off the end for the
 * other
 */
export const GAUGE_MAX_EXPRESSION = `${WARNING} + ${WARNING_BAND + RED_BAND}`

/**
 * The gauge's colour bands. Each starts at its `from`, an expression of the warning temperature so the bands follow
 * `warnTemperature`, and runs to the next. With an XCPU's 55°C: green to 45, yellow to 55, amber to 65, red to 70
 */
export const GAUGE_BANDS = [
	{ name: 'normal', from: String(TEMPERATURE.min), color: '#43a047' },
	{ name: 'approaching', from: `${WARNING} - ${WARNING_BAND}`, color: '#fdd835' },
	{ name: 'warning', from: WARNING, color: '#fb8c00' },
	{ name: 'over', from: `${WARNING} + ${WARNING_BAND}`, color: '#e53935' },
] as const

/**
 * Where each part of the button goes, as percentages of the button, top to bottom. Six rows fit only without the top
 * bar, which the preset turns off. The rows touch: a text element keeps its own small margin
 */
export const LAYOUT = {
	title: { y: 0, height: 20 },
	/** Short of the right edge, for the status light */
	status: { x: 2, y: 20, width: 74, height: 16 },
	/** Square, so round on a square button. On the right of the status row, below the device name */
	statusLight: { x: 80, y: 21, width: 14, height: 14 },
	boards: { y: 36, height: 16 },
	power: { y: 52, height: 16 },
	temperature: { y: 68, height: 16 },
	gauge: { x: 6, y: 86, width: 88, height: 10 },
} as const

/**
 * A text element's fontsize is a percentage of the element's own height, 100 filling it, not of the button. Slightly
 * under, so a line never touches the next, and shrinking to fit the width
 */
export const ROW_FONTSIZE = 90

const text = (row: { x?: number; y: number; width?: number; height: number }, value: string) =>
	({
		type: 'text',
		x: row.x ?? 2,
		y: row.y,
		width: row.width ?? 96,
		height: row.height,
		text: { isExpression: true, value },
		fontsize: ROW_FONTSIZE,
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
		// The top bar would take a fifth of the button, leaving too little for six rows
		canvas: { decoration: ButtonGraphicsDecorationType.Border },
		elements: [
			{
				type: 'box',
				id: 'background',
				name: 'Background',
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				color: COLORS.background,
			},
			{
				...text(LAYOUT.title, TITLE_EXPRESSION),
				id: 'title',
				name: 'Device',
				weight: 'bold',
			},
			{ ...text(LAYOUT.status, STATUS_EXPRESSION), id: 'status', name: 'Online' },
			{
				type: 'circle',
				id: 'status_light',
				name: 'Status Light',
				...LAYOUT.statusLight,
				color: { isExpression: true, value: STATUS_LIGHT_EXPRESSION },
			},
			{ ...text(LAYOUT.boards, BOARDS_EXPRESSION), id: 'boards', name: 'Boards' },
			{ ...text(LAYOUT.power, POWER_EXPRESSION), id: 'power', name: 'Power Units' },
			{ ...text(LAYOUT.temperature, TEMPERATURE_EXPRESSION), id: 'temperature', name: 'CPU Temperature' },
			{
				type: 'gauge',
				id: 'temperature_gauge',
				name: 'CPU Temperature Gauge',
				...LAYOUT.gauge,
				orientation: 'horizontal',
				value: { isExpression: true, value: GAUGE_EXPRESSION },
				min: TEMPERATURE.min,
				max: { isExpression: true, value: GAUGE_MAX_EXPRESSION },
				// One colour for the whole fill, the band the temperature is in, so the bar flips as it crosses each.
				// Companion takes the colour of the highest stop at or below the value
				multiColour: false,
				stops: GAUGE_BANDS.map(({ name, from, color }) => ({
					value: name === 'normal' ? TEMPERATURE.min : { isExpression: true, value: from },
					color,
					gradient: false,
				})),
				trackStyle: 'dimmed',
				trackAmount: GAUGE_TRACK_AMOUNT,
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
