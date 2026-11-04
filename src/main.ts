import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import snmp from 'net-snmp'
import { CONFIG_DEFAULTS, GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateActions, type ActionSchema } from './actions.js'
import { FeedbackId, UpdateFeedbacks, type FeedbackSchema } from './feedbacks.js'
import {
	AllVariableValues,
	countVariable,
	latchVariable,
	StatusVariableValues,
	UpdateVariableDefinitions,
	type VariablesSchema,
} from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdatePresets } from './presets.js'
import { FeedbackSubscriptions } from './subscriptions.js'
import { XciClient } from './client.js'
import { TrapListener } from './listener.js'
import { NexusState, parseErrorTrap, pollStatus, trapName, type NexusStatus } from './nexus.js'
import { StatusTracker } from './status.js'
import { CELL_COUNT, LogicCells, parseLogicVarbinds, pollLogicCells, type VarbindProblem } from './xci.js'

export type ModuleTypes = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionSchema
	feedbacks: FeedbackSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export default class ModuleInstance extends InstanceBase<ModuleTypes> {
	#config!: ModuleConfig // Setup in init()
	readonly cells = new LogicCells()
	readonly nexus = new NexusState()
	/** The trap feedbacks in use, by the cell each reads */
	readonly trapFeedbacks = new FeedbackSubscriptions()
	/** The latched trap feedbacks in use, by the cell each reads */
	readonly latchFeedbacks = new FeedbackSubscriptions()
	readonly #status = new StatusTracker((status, message) => this.updateStatus(status, message))
	#listener: TrapListener | undefined
	#client: XciClient | undefined
	/** Aborted by a config change or destroy, ending the polls in flight */
	#controller = new AbortController()
	#statusTimer: NodeJS.Timeout | undefined
	/** The cells traps have reported since the cell poll in flight started. Its results for them are older, so are dropped */
	#trappedDuringPoll: Set<number> | undefined
	/** Set by an error trap during the status poll in flight. The error table it read is older, so is dropped */
	#errorTrapDuringPoll: { arrived: boolean } | undefined
	/** The device limit the feedback definitions were last set with, see {@link NexusState.deviceLimit} */
	#deviceLimit: number | undefined
	/** The status variable values last sent, so a poll sends only what changed */
	readonly #published = new Map<string, unknown>()

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
		this.updatePresets() // export presets, which list the base devices once read
		await this.configUpdated(config)
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		this.#stopPolling()
		this.#listener?.close()
		this.#listener = undefined
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.#config = { ...CONFIG_DEFAULTS, ...config }
		this.log('debug', `Config Updated. IP: ${config.host} Community String: ${config.community}`)
		this.#stopPolling()
		this.#listener?.close()
		this.#listener = undefined
		this.#status.reset()
		this.#resetState()
		if (!config.host) {
			this.#status.set('config', InstanceStatus.BadConfig, 'Missing IP')
			this.log('error', 'Invalid config - missing IP')
			return
		}
		this.#status.set('listener', InstanceStatus.Connecting)
		const listener = new TrapListener({
			host: config.host,
			community: config.community,
			createSocket: () => this.createSharedUdpSocket('udp4'),
			onTrap: (error, notification) => this.#onTrap(error, notification),
			onError: (err) => this.#status.set('listener', InstanceStatus.UnknownError, err.message),
			log: (level, message) => this.log(level, message),
		})
		this.#listener = listener
		try {
			await listener.start()
		} catch (err) {
			if (this.#listener !== listener) return
			this.log('error', `Agent initialisation failed: ${errorMessage(err)}`)
			this.#status.set('listener', InstanceStatus.UnknownError, errorMessage(err))
		}
		// Superseded by a config change or destroy while binding, which has started what it needs
		if (this.#listener !== listener) return
		if (listener.listening) this.#status.set('listener', InstanceStatus.Ok)
		// After the listener, so a cell that changes while the poll runs is caught by its trap
		this.#startPolling()
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		this.#deviceLimit = this.nexus.deviceLimit
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	/** Reads the logic cells and the Nexus status now. The status poll keeps its interval */
	refresh(): void {
		const client = this.#client
		if (!client) return
		const { signal } = this.#controller
		void this.#pollLogicCells(client, signal)
		void this.#pollStatus(client, signal)
	}

	/** @throws if the cell is out of range */
	resetLatch(cell: number): void {
		const wasSet = this.cells.resetLatch(cell)
		this.log('debug', `Resetting latch ${cell}`)
		const values: Partial<VariablesSchema> = {}
		values[latchVariable(cell)] = false
		this.setVariableValues(values)
		if (wasSet) this.#checkFeedbacksFor(this.latchFeedbacks, cell)
	}

	resetAllLatches(): void {
		const values: Partial<VariablesSchema> = {}
		for (let cell = 1; cell <= CELL_COUNT; cell++) {
			this.cells.resetLatch(cell)
			values[latchVariable(cell)] = false
		}
		this.log('debug', 'Resetting all latches')
		this.setVariableValues(values)
		this.checkFeedbacks(FeedbackId.TrapLatch)
	}

	/** @throws if the cell is out of range */
	resetCount(cell: number): void {
		this.cells.resetCount(cell)
		this.log('debug', `Resetting count ${cell}`)
		const values: Partial<VariablesSchema> = {}
		values[countVariable(cell)] = 0
		this.setVariableValues(values)
	}

	resetAllCounts(): void {
		const values: Partial<VariablesSchema> = {}
		for (let cell = 1; cell <= CELL_COUNT; cell++) {
			this.cells.resetCount(cell)
			values[countVariable(cell)] = 0
		}
		this.log('debug', 'Resetting all counts')
		this.setVariableValues(values)
	}

	/**
	 * Clears everything read from the XCI. Every feedback is rechecked: the registries only list feedbacks by cell, and
	 * any of them may have changed
	 */
	#resetState(): void {
		const hadDevices = this.nexus.devices.size > 0
		this.cells.reset()
		this.nexus.reset()
		this.#published.clear()
		if (this.nexus.deviceLimit !== this.#deviceLimit) this.updateFeedbacks()
		if (hadDevices) {
			this.updateVariableDefinitions()
			this.updatePresets()
		}
		this.setVariableValues(AllVariableValues(this.cells))
		this.#publishStatus()
		this.#checkFeedbackTypes(Object.values(FeedbackId))
	}

	#stopPolling(): void {
		this.#controller.abort()
		this.#controller = new AbortController()
		clearTimeout(this.#statusTimer)
		this.#statusTimer = undefined
		this.#client?.close()
		this.#client = undefined
	}

	#startPolling(): void {
		const { host, community, version, port } = this.#config
		try {
			this.#client = new XciClient(host, community, { version, port })
		} catch (err) {
			this.log('error', `SNMP client failed to start: ${errorMessage(err)}`)
			return
		}
		const { signal } = this.#controller
		void this.#pollLogicCells(this.#client, signal)
		void this.#statusLoop(this.#client, signal)
	}

	/**
	 * Reads the state of every logic cell, so the feedbacks show it without waiting for each cell's next trap. A cell
	 * found true sets its latch, but isn't counted, see {@link LogicCells.setValue}
	 */
	async #pollLogicCells(client: XciClient, signal: AbortSignal): Promise<void> {
		const trapped = new Set<number>()
		this.#trappedDuringPoll = trapped
		try {
			const { reports, problems, failures } = await pollLogicCells(async (oids, s) => client.get(oids, s), signal)
			if (signal.aborted) return
			this.#logProblems(problems)
			for (const { oid, error } of failures) this.log('warn', `Reading ${oid} failed: ${error.message}`)

			const values: Partial<VariablesSchema> = {}
			const feedbackIds = new Set<string>()
			for (const report of reports) {
				if (trapped.has(report.cell)) continue
				const { cell } = report
				const { valueChanged, latchChanged } = this.cells.setValue(report)
				if (valueChanged) this.trapFeedbacks.feedbacksFor(cell).forEach((id) => feedbackIds.add(id))
				if (latchChanged) {
					this.latchFeedbacks.feedbacksFor(cell).forEach((id) => feedbackIds.add(id))
					values[latchVariable(cell)] = true
				}
			}
			if (Object.keys(values).length > 0) this.setVariableValues(values)
			if (feedbackIds.size > 0) this.checkFeedbacksById(...feedbackIds)
			this.log('info', `Read ${reports.length} logic cells from ${this.#config.host}`)
			this.#status.set('cells', InstanceStatus.Ok)
		} catch (err) {
			if (signal.aborted) return
			this.log('warn', `Reading the logic cells failed: ${errorMessage(err)}`)
			this.#status.set('cells', InstanceStatus.UnknownWarning, `Reading the logic cells failed: ${errorMessage(err)}`)
		} finally {
			if (this.#trappedDuringPoll === trapped) this.#trappedDuringPoll = undefined
		}
	}

	/** Reads the Nexus status, then again every poll interval until aborted */
	async #statusLoop(client: XciClient, signal: AbortSignal): Promise<void> {
		await this.#pollStatus(client, signal)
		const interval = this.#config.pollInterval
		if (signal.aborted || !(interval > 0)) return
		this.#statusTimer = setTimeout(() => void this.#statusLoop(client, signal), interval * 1000)
	}

	async #pollStatus(client: XciClient, signal: AbortSignal): Promise<void> {
		const errorTraps = { arrived: false }
		this.#errorTrapDuringPoll = errorTraps
		try {
			const status = await pollStatus(
				async (oids, s) => client.get(oids, s),
				async (oid, s) => client.walk(oid, s),
				signal,
			)
			if (signal.aborted) return
			if (status.missing.length > 0) this.log('debug', `Not reported by the XCI: ${status.missing.join(', ')}`)
			for (const { oid, error } of status.failures) this.log('warn', `Reading ${oid} failed: ${error.message}`)
			this.#applyStatus(status, errorTraps.arrived)
			this.#status.set('status', InstanceStatus.Ok)
		} catch (err) {
			if (signal.aborted) return
			this.log('warn', `Reading the Nexus status failed: ${errorMessage(err)}`)
			this.#status.set('status', InstanceStatus.UnknownWarning, `Reading the Nexus status failed: ${errorMessage(err)}`)
		} finally {
			if (this.#errorTrapDuringPoll === errorTraps) this.#errorTrapDuringPoll = undefined
		}
	}

	#applyStatus(status: NexusStatus, keepErrors: boolean): void {
		const changed = this.nexus.update(status, keepErrors)
		// Base Device Health's device option is limited to the devices there are. Companion validates option values
		// against it on every check, so the feedback is rechecked below to apply a new limit
		const limitChanged = this.nexus.deviceLimit !== this.#deviceLimit
		if (limitChanged) this.updateFeedbacks()
		if (changed.deviceIds) {
			this.updateVariableDefinitions()
			this.updatePresets()
		}
		this.#publishStatus()
		const feedbacks = new Set<FeedbackId>()
		if (changed.scalars) [FeedbackId.SystemHealth, FeedbackId.SyncSource].forEach((id) => feedbacks.add(id))
		if (changed.devices) [FeedbackId.DeviceHealth, FeedbackId.SystemHealth].forEach((id) => feedbacks.add(id))
		if (limitChanged) feedbacks.add(FeedbackId.DeviceHealth)
		if (changed.errors) [FeedbackId.ErrorCount, FeedbackId.SystemHealth].forEach((id) => feedbacks.add(id))
		this.#checkFeedbackTypes(feedbacks)
	}

	/** Sends the status variables that changed since last sent */
	#publishStatus(): void {
		const values: Record<string, unknown> = {}
		for (const [id, value] of Object.entries(StatusVariableValues(this.nexus))) {
			if (this.#published.has(id) && this.#published.get(id) === value) continue
			this.#published.set(id, value)
			values[id] = value
		}
		if (Object.keys(values).length > 0) this.setVariableValues(values as Partial<VariablesSchema>)
	}

	#logProblems(problems: VarbindProblem[]): void {
		for (const { kind, varbind } of problems) {
			switch (kind) {
				case 'no-value':
					this.log('warn', `OID: ${varbind.oid} has no value field`)
					break
				case 'out-of-range':
					this.log('debug', `OID out of range: ${varbind.oid}, raw value: ${String(varbind.value)}`)
					break
				case 'varbind-error':
					this.log('warn', snmp.varbindError(varbind))
					break
				default: {
					const exhaustive: never = kind
					this.log('warn', `OID: ${varbind.oid}: ${String(exhaustive)}`)
				}
			}
		}
	}

	#checkFeedbackTypes(types: Iterable<FeedbackId>): void {
		const [first, ...rest] = [...types]
		if (first !== undefined) this.checkFeedbacks(first, ...rest)
	}

	#checkFeedbacksFor(subscriptions: FeedbackSubscriptions, cell: number): void {
		const ids = subscriptions.feedbacksFor(cell)
		if (ids.length > 0) this.checkFeedbacksById(...ids)
	}

	#onTrap(error: Error | null, notification?: snmp.Notification): void {
		if (error) {
			this.log('error', `Trap error: ${error.name}: ${error.message}`)
			this.#status.set('traps', InstanceStatus.UnknownError, error.message)
			return
		}
		if (!notification) return
		const { pdu, rinfo } = notification
		const { host, community } = this.#config
		if (rinfo.address !== host) {
			this.#status.set('traps', InstanceStatus.UnknownWarning, 'Trap received from unexpected IP')
			this.log('error', `Unexpected trap received from ${rinfo.address}`)
			return
		}
		if (pdu.community !== community) {
			this.#status.set('traps', InstanceStatus.BadConfig, 'Incorrect Community')
			this.log('error', `Expected community: ${community} Received community: ${pdu.community}`)
			return
		}
		if (!Array.isArray(pdu.varbinds)) {
			this.#status.set('traps', InstanceStatus.UnknownWarning, 'Trap has no Varbinds')
			this.log('error', `Received trap contains no varbinds`)
			return
		}
		this.#status.set('traps', InstanceStatus.Ok)

		const name = trapName(pdu)
		switch (name) {
			case 'errorOccured':
			case 'errorList':
				this.#onErrorTrap(pdu.varbinds, true)
				break
			case 'errorRemoved':
			case 'removeList':
				this.#onErrorTrap(pdu.varbinds, false)
				break
			case 'signalChange':
			case 'signalList':
			case undefined:
				// Read any trap that isn't an error trap for logic cells, as the JavaScript module read every trap
				this.#onSignalTrap(pdu.varbinds)
				break
			default: {
				const exhaustive: never = name
				this.log('debug', `Unhandled trap ${String(exhaustive)}`)
			}
		}
	}

	#onErrorTrap(varbinds: snmp.Varbind[], occured: boolean): void {
		const events = parseErrorTrap(varbinds, occured)
		for (const { node, code, name, param } of events) {
			this.log('warn', `Nexus error ${occured ? 'occured' : 'removed'}: node ${node} code ${code} ${name} ${param}`)
		}
		if (this.#errorTrapDuringPoll) this.#errorTrapDuringPoll.arrived = true
		if (!this.nexus.errors.apply(events)) return
		this.#publishStatus()
		this.checkFeedbacks(FeedbackId.ErrorCount, FeedbackId.SystemHealth)
	}

	#onSignalTrap(varbinds: snmp.Varbind[]): void {
		const { reports, problems } = parseLogicVarbinds(varbinds)
		this.#logProblems(problems)

		const values: Partial<VariablesSchema> = {}
		const feedbackIds = new Set<string>()
		for (const report of reports) {
			const { cell, value } = report
			this.log('info', `Logic Cell ${cell} set to ${value}`)
			this.#trappedDuringPoll?.add(cell)
			const { valueChanged, latchChanged } = this.cells.report(report)
			if (valueChanged) this.trapFeedbacks.feedbacksFor(cell).forEach((id) => feedbackIds.add(id))
			if (latchChanged) this.latchFeedbacks.feedbacksFor(cell).forEach((id) => feedbackIds.add(id))
			if (value) {
				const state = this.cells.get(cell)
				values.mostRecent = cell
				values[latchVariable(cell)] = state.latch
				values[countVariable(cell)] = state.count
			}
		}
		if (Object.keys(values).length > 0) this.setVariableValues(values)
		if (feedbackIds.size > 0) this.checkFeedbacksById(...feedbackIds)
	}
}
