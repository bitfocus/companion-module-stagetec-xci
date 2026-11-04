import { describe, expect, it, vi } from 'vitest'
import type {
	CompanionLayeredButtonPresetDefinition,
	CompanionPresetDefinitions,
	CompanionPresetSection,
} from '@companion-module/base'
import type ModuleInstance from '../main.js'
import type { ModuleTypes } from '../main.js'
import { DeviceProperty, FeedbackId, deviceHealth } from '../feedbacks.js'
import { NexusState, type BaseDevice } from '../nexus.js'
import {
	BACKGROUND_EXPRESSION,
	BOARDS_EXPRESSION,
	COLORS,
	DEVICE_VARIABLE,
	GAUGE_BANDS,
	GAUGE_EXPRESSION,
	HEALTH_VARIABLES,
	POWER_EXPRESSION,
	PresetId,
	STATUS_EXPRESSION,
	TEMPERATURE,
	TEMPERATURE_EXPRESSION,
	TITLE_EXPRESSION,
	WARNING_VARIABLE,
	XCI_WARNING,
	XCPU_WARNING,
	UpdatePresets,
	baseDeviceHealthPreset,
} from '../presets.js'
import { fakeInstance, feedbackDefinitions } from './fixtures.js'

/**
 * Runs a preset expression as JavaScript, which Companion's expression syntax also is, with each `$(local:x)` replaced
 * by its value. Checks what a button shows without running Companion
 */
function evaluate(expression: string, locals: Record<string, unknown>): unknown {
	const js = expression.replace(/\$\(local:(\w+)\)/g, (_, name: string) => {
		if (!(name in locals)) throw new Error(`No local variable ${name}`)
		return JSON.stringify(locals[name] ?? null)
	})
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	return new Function(`return (${js})`)() as unknown
}

/** The local variables a placed preset would hold for a device, from the real Base Device Health feedback */
function localsFor(
	device: BaseDevice | undefined,
	number = 1,
	warning: number = XCPU_WARNING,
): Record<string, unknown> {
	return {
		[DEVICE_VARIABLE]: number,
		[WARNING_VARIABLE]: warning,
		...Object.fromEntries(HEALTH_VARIABLES.map((property) => [property, deviceHealth(device, property)])),
	}
}

const HEALTHY: BaseDevice = {
	online: true,
	configBoards: 8,
	availBoards: 8,
	powerUnits: 2,
	pwrGoodUnits: 2,
	cpuTemperature: 41,
	cpuMaxTemp: 55,
}

const preset = baseDeviceHealthPreset()

/** Every expression the preset's elements hold */
function expressions(definition: CompanionLayeredButtonPresetDefinition<ModuleTypes>): string[] {
	const found: string[] = []
	const walk = (value: unknown): void => {
		if (value && typeof value === 'object') {
			if ('isExpression' in value && value.isExpression === true && 'value' in value) found.push(String(value.value))
			else Object.values(value).forEach(walk)
		}
	}
	walk(definition.elements)
	return found
}

describe('base device health preset', () => {
	it('reads each value from Base Device Health, for the device its local variable names', () => {
		const feedbacks = feedbackDefinitions(fakeInstance())
		const definition = feedbacks[FeedbackId.DeviceHealth]
		if (!definition) throw new Error('No Base Device Health feedback')
		const property = definition.options.find((option) => option.id === 'property')
		const offered = property?.type === 'dropdown' ? property.choices.map(({ id }) => id) : []

		const feedbackLocals = preset.localVariables?.filter((local) => local.variableType === 'feedback') ?? []
		expect(feedbackLocals.map(({ variableName }) => variableName)).toEqual([...HEALTH_VARIABLES])
		for (const local of feedbackLocals) {
			expect(local).toMatchObject({
				feedbackId: FeedbackId.DeviceHealth,
				options: { device: { isExpression: true, value: `$(local:${DEVICE_VARIABLE})` }, property: local.variableName },
			})
			expect(offered).toContain(local.variableName)
			expect(DeviceProperty).toContain(local.variableName)
		}
		expect(preset.localVariables?.[1]).toEqual({
			variableType: 'simple',
			variableName: WARNING_VARIABLE,
			startupValue: XCPU_WARNING,
		})
		expect(preset.localVariables?.[0]).toEqual({
			variableType: 'simple',
			variableName: DEVICE_VARIABLE,
			startupValue: 1,
		})
	})

	it('reads only local variables it defines', () => {
		const defined = new Set(preset.localVariables?.map(({ variableName }) => variableName))
		const read = expressions(preset).flatMap((expression) =>
			[...expression.matchAll(/\$\(local:(\w+)\)/g)].map(([, name]) => name),
		)
		expect(read.length).toBeGreaterThan(0)
		for (const name of read) expect(defined).toContain(name)
	})

	it('draws with the expressions tested here', () => {
		expect(expressions(preset).toSorted()).toEqual(
			[
				BACKGROUND_EXPRESSION,
				TITLE_EXPRESSION,
				STATUS_EXPRESSION,
				BOARDS_EXPRESSION,
				POWER_EXPRESSION,
				TEMPERATURE_EXPRESSION,
				GAUGE_EXPRESSION,
				...GAUGE_BANDS.filter(({ name }) => name !== 'normal').map(({ from }) => from),
			].toSorted(),
		)
	})

	it('gives every element its own id', () => {
		const ids = preset.elements.map((element) => element.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	describe('background', () => {
		it.each([
			['green when all is well', HEALTHY, COLORS.ok],
			['amber with a board missing', { ...HEALTHY, availBoards: 7 }, COLORS.degraded],
			['amber with a power unit failed', { ...HEALTHY, pwrGoodUnits: 1 }, COLORS.degraded],
			['red when offline, whatever else', { ...HEALTHY, online: false, availBoards: 7 }, COLORS.offline],
			['grey for a device not read', undefined, COLORS.unknown],
			['grey when the XCI gives no online state', { configBoards: 8 }, COLORS.unknown],
			['green when online without board or power counts', { online: true }, COLORS.ok],
		])('is %s', (_, device, color) => {
			expect(evaluate(BACKGROUND_EXPRESSION, localsFor(device))).toBe(color)
		})

		it.each([
			['green below the XCPU warning temperature', XCPU_WARNING - 1, XCPU_WARNING, COLORS.ok],
			['amber at the XCPU warning temperature, as Nexus Service warns', XCPU_WARNING, XCPU_WARNING, COLORS.degraded],
			['green at that temperature with an XCI’s threshold set', XCPU_WARNING, XCI_WARNING, COLORS.ok],
			['amber at the XCI warning temperature with it set', XCI_WARNING, XCI_WARNING, COLORS.degraded],
		])('is %s', (_, cpuTemperature, warning, color) => {
			expect(evaluate(BACKGROUND_EXPRESSION, localsFor({ ...HEALTHY, cpuTemperature }, 1, warning))).toBe(color)
		})

		it('is red when offline, however hot', () => {
			expect(evaluate(BACKGROUND_EXPRESSION, localsFor({ ...HEALTHY, online: false, cpuTemperature: 99 }))).toBe(
				COLORS.offline,
			)
		})
	})

	describe('text', () => {
		it('shows the device, its state, its boards, power units and temperature', () => {
			const locals = localsFor({ ...HEALTHY, availBoards: 7 }, 3)
			expect(evaluate(TITLE_EXPRESSION, locals)).toBe('Device 3')
			expect(evaluate(STATUS_EXPRESSION, locals)).toBe('Online')
			expect(evaluate(BOARDS_EXPRESSION, locals)).toBe('Boards 7/8')
			expect(evaluate(POWER_EXPRESSION, locals)).toBe('PSU 2/2')
			expect(evaluate(TEMPERATURE_EXPRESSION, locals)).toBe('CPU 41°C')
		})

		it('shows dashes for what hasn’t been read', () => {
			const locals = localsFor(undefined)
			expect(evaluate(STATUS_EXPRESSION, locals)).toBe('-')
			expect(evaluate(BOARDS_EXPRESSION, locals)).toBe('Boards -/-')
			expect(evaluate(POWER_EXPRESSION, locals)).toBe('PSU -/-')
			expect(evaluate(TEMPERATURE_EXPRESSION, locals)).toBe('CPU -°C')
		})

		it('says OFFLINE when offline', () => {
			expect(evaluate(STATUS_EXPRESSION, localsFor({ ...HEALTHY, online: false }))).toBe('OFFLINE')
		})
	})

	it('draws the CPU temperature, empty until read', () => {
		expect(evaluate(GAUGE_EXPRESSION, localsFor(HEALTHY))).toBe(41)
		expect(evaluate(GAUGE_EXPRESSION, localsFor(undefined))).toBe(TEMPERATURE.min)
		expect(preset.elements.find((element) => element.id === 'temperature_gauge')).toMatchObject({
			min: TEMPERATURE.min,
			max: TEMPERATURE.max,
			multiColour: false,
		})
	})

	describe('temperature gauge colour', () => {
		const gauge = preset.elements.find((element) => element.id === 'temperature_gauge') as unknown as {
			stops: { value: number | { isExpression: true; value: string }; color: string; gradient: boolean }[]
		}
		const color = (name: (typeof GAUGE_BANDS)[number]['name']) => GAUGE_BANDS.find((band) => band.name === name)!.color

		/** The fill colour, as Companion's GaugeColorModel picks it with multiColour off: the highest stop at or below */
		function fill(cpuTemperature: number, warning: number): string {
			const locals = localsFor({ ...HEALTHY, cpuTemperature }, 1, warning)
			const stops = gauge.stops
				.map(({ value, color }) => ({
					at: typeof value === 'number' ? value : (evaluate(value.value, locals) as number),
					color,
				}))
				.sort((a, b) => a.at - b.at)
			let result = stops[0].color
			for (const stop of stops) if (stop.at <= cpuTemperature) result = stop.color
			return result
		}

		it.each([
			[XCPU_WARNING, 44, 'normal'],
			[XCPU_WARNING, 45, 'approaching'],
			[XCPU_WARNING, 54, 'approaching'],
			[XCPU_WARNING, 55, 'warning'],
			[XCPU_WARNING, 64, 'warning'],
			[XCPU_WARNING, 65, 'over'],
			[XCPU_WARNING, 99, 'over'],
			[XCI_WARNING, 69, 'normal'],
			[XCI_WARNING, 70, 'approaching'],
			[XCI_WARNING, 80, 'warning'],
			[XCI_WARNING, 90, 'over'],
		] as const)('with a warning at %i°C, %i°C is %s', (warning, temperature, band) => {
			expect(fill(temperature, warning)).toBe(color(band))
		})

		it('fills in one colour, with no gradient', () => {
			expect(gauge).toMatchObject({ multiColour: false })
			expect(gauge.stops.every(({ gradient }) => !gradient)).toBe(true)
			expect(new Set(GAUGE_BANDS.map(({ color }) => color)).size).toBe(GAUGE_BANDS.length)
		})
	})
})

describe('UpdatePresets', () => {
	function update(devices: number[]) {
		const nexus = new NexusState()
		for (const device of devices) nexus.devices.set(device, {})
		const setPresetDefinitions =
			vi.fn<
				(structure: CompanionPresetSection<ModuleTypes>[], presets: CompanionPresetDefinitions<ModuleTypes>) => void
			>()
		UpdatePresets({ nexus, setPresetDefinitions } as unknown as ModuleInstance)
		const [structure, presets] = setPresetDefinitions.mock.calls[0]
		return { group: structure[0].definitions[0], presets }
	}

	it('offers the preset for each base device read', () => {
		const { group, presets } = update([1, 4])
		expect(group).toMatchObject({
			type: 'template',
			presetId: PresetId.BaseDeviceHealth,
			templateVariableName: DEVICE_VARIABLE,
			templateValues: [
				{ name: 'Base Device 1', value: 1 },
				{ name: 'Base Device 4', value: 4 },
			],
		})
		expect(group).not.toHaveProperty('commonVariableValues')
		expect(presets[PresetId.BaseDeviceHealth]).toBeDefined()
	})

	it('offers it on its own until the devices have been read', () => {
		const { group, presets } = update([])
		expect(group).toMatchObject({ type: 'simple', presets: [PresetId.BaseDeviceHealth] })
		expect(presets[PresetId.BaseDeviceHealth]).toBeDefined()
	})
})
