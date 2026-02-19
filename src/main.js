import { InstanceBase, runEntrypoint, Regex, InstanceStatus } from '@companion-module/base'
import UpgradeScripts from './upgrades.js'
import UpdateActions from './actions.js'
import UpdateFeedbacks from './feedbacks.js'
import UpdateVariableDefinitions from './variables.js'
import { SharedUDPSocketWrapper } from './wrapper.js'
import snmp from 'net-snmp'
const xciLogicOid = '1.3.6.1.4.1.40085.1.1.1.3.2.3.1.2.'
const xciLogicTrue = 2

const SnmpAgentOptions = {
	port: 162,
	disableAuthorization: true,
	includeAuthentication: true,
	accessControlModelType: snmp.AccessControlModelType.None,
	engineID: '8000B983800123456789ABCDEF01234567', // where the X's are random hex digits
	address: null,
	transport: 'udp4',
}

const trapCallback = function (error, notification) {
	if (error) {
		this.log('error', `Trap error name: ${error.name}`)
		this.log('error', `Trap error message: ${error.message}`)
		this.log('error', `Trap error keys: ${Object.getOwnPropertyNames(error).join(', ')}`)
		this.log('error', `Trap error full: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`)
		this.updateStatus(InstanceStatus.UnknownError, JSON.stringify(error))
	} else {
		const trap = notification
		let varbinds = []
		varbinds = trap.pdu.varbinds
		if (trap.rinfo.address !== this.config.host) {
			this.updateStatus(InstanceStatus.UnknownWarning, 'Trap recieved from unexpected IP')
			this.log('error', `Unexpected trap recieved from ${trap.rinfo.address}`)
			return
		}
		if (trap.pdu.community !== this.config.community) {
			this.updateStatus(InstanceStatus.BadConfig, 'Incorrect Community')
			this.log('error', `Expected community: ${this.config.community} Recieved community: ${trap.pdu.community}`)
			return
		}
		if (varbinds === undefined || varbinds === null) {
			this.updateStatus(InstanceStatus.UnknownWarning, 'Trap has no Varbinds')
			this.log('error', `Received trap contains no varbinds`)
			return
		}
		this.updateStatus(InstanceStatus.Ok, 'Trap Recieved')
		for (let i = 0; i < varbinds.length; i++) {
			if (varbinds[i].value !== undefined) {
				let oid = varbinds[i].oid
				if (oid.startsWith(xciLogicOid)) {
					oid = oid.split('.')
					if (oid.length == 16) {
						const logicCell = parseInt(oid[15])
						const value = varbinds[i].value == xciLogicTrue ? true : false
						if (logicCell >= 1 && logicCell <= 256) {
							this.logicCell[logicCell].value = value
							this.log('info', `Logic Cell ${logicCell} set to ${value}`)
							let feedbacksToCheck = ['xciSnmpTrap']
							if (value) {
								let varList = []
								this.mostRecent = logicCell
								this.logicCell[logicCell].latch = value
								this.logicCell[logicCell].count += 1
								varList['mostRecent'] = this.mostRecent
								varList[`cellLatch_${logicCell}`] = value
								varList[`cellCount_${logicCell}`] = this.logicCell[logicCell].count
								this.setVariableValues(varList)
								feedbacksToCheck.push('xciSnmpTrapLatch')
							}
							this.checkFeedbacks(...feedbacksToCheck)
						} else {
							this.log('debug', `OID out of range: ${varbinds[i].oid}, raw value: ${varbinds[i].value}`)
						}
					}
				}
				continue
			}
			this.log('warn', `OID: ${varbinds[i].oid} has no value field`)
		}
	}
}

class StagetecXCI extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	async init(config) {
		this.config = config
		if (this.config.host === undefined || this.config.host === '') {
			this.updateStatus(InstanceStatus.BadConfig)
			this.log('error', 'Invalid config - missing IP')
		} else {
			try {
				await this.initAgent()
			} catch (err) {
				this.log('error', `Agent initialisation failed: ${err.message ?? ''}`)
				this.updateStatus(InstanceStatus.UnknownError)
			}
		}
		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
		this.resetVariables()
	}
	// When module gets deleted
	async destroy() {
		this.log('debug', 'destroy')
		this.closeListener()
	}

	closeListener() {
		if (this.snmpReciever) {
			this.snmpReciever.close()
		}

		if (this.socketWrapper) {
			this.socketWrapper.close()
			this.socketWrapper.removeAllListeners()
		}

		if (this.listeningSocket) {
			this.listeningSocket.close()
			this.listeningSocket.removeAllListeners()
		}
	}

	async initAgent() {
		this.closeListener()

		return new Promise((resolve, reject) => {
			this.listeningSocket = this.createSharedUdpSocket('udp4')

			const errorHandler = (err) => {
				this.log('error', `Listener error: ${err.message}`)
				this.listeningSocket.removeAllListeners()
				reject(err)
			}
			this.listeningSocket.addListener('error', errorHandler)

			this.listeningSocket.addListener('listening', () => {
				this.log('info', `Listening`)
			})

			this.listeningSocket.bind(162, this.config.host, () => {
				try {
					this.listeningSocket.removeListener('error', errorHandler)
					this.socketWrapper = new SharedUDPSocketWrapper(this.listeningSocket, 162, this.config.host)
					const receiverOptions = {
						...SnmpAgentOptions,
						dgramModule: this.socketWrapper,
					}
					this.snmpReciever = snmp.createReceiver(receiverOptions, trapCallback.bind(this))
					this.snmpReciever.authorizer.addCommunity(this.config.community)
					this.log('info', `Bound to Port 162 and waiting for Traps from ${this.config.host}`)
					this.updateStatus(InstanceStatus.Ok)
					resolve()
				} catch (err) {
					this.listeningSocket.removeAllListeners()
					console.error(err)
					reject(err)
				}
			})
		})
	}

	async resetVariables() {
		let varList = []
		this.logicCell = []
		for (let i = 1; i <= 256; i++) {
			this.logicCell[i] = {
				value: false,
				latch: false,
				count: 0,
			}
			varList[`cellLatch_${i}`] = this.logicCell[i].latch
			varList[`cellCount_${i}`] = this.logicCell[i].count
		}
		this.mostRecent = 0
		varList['mostRecent'] = this.mostRecent
		this.setVariableValues(varList)
		this.checkFeedbacks('xciSnmpTrap')
	}

	async configUpdated(config) {
		this.config = config
		this.log('debug', `Config Updated. IP: ${this.config.host} Community String: ${this.config.community}`)
		if (this.config.host === undefined || this.config.host === '') {
			this.updateStatus(InstanceStatus.BadConfig)
			this.log('error', 'Invalid config - missing IP')
		} else {
			try {
				await this.initAgent()
			} catch (err) {
				this.log('error', `Agent initialisation failed: ${err.message ?? ''}`)
				this.updateStatus(InstanceStatus.UnknownError)
			}
		}
		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
		this.resetVariables()
	}

	// Return config fields for web config
	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'XCI IP',
				width: 8,
				regex: Regex.IP,
				tooltip: 'The IP of the Nexus XCI',
			},
			{
				type: 'textinput',
				id: 'community',
				label: 'Community String',
				width: 4,
				regex: Regex.SOMETHING,
				default: 'public',
				tooltip: 'The configured community string',
			},
		]
	}

	updateActions() {
		UpdateActions(this)
	}

	updateFeedbacks() {
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions() {
		UpdateVariableDefinitions(this)
	}
}

runEntrypoint(StagetecXCI, UpgradeScripts)
