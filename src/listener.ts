import { createModuleLogger, type SharedUdpSocket } from '@companion-module/base'
import snmp from 'net-snmp'
import { SharedUDPSocketWrapper } from './wrapper.js'

export const SNMP_TRAP_PORT = 162

const SnmpReceiverOptions = {
	port: SNMP_TRAP_PORT,
	// The community is checked by the instance instead, so a trap with the wrong one can be reported
	disableAuthorization: true,
	includeAuthentication: true,
	accessControlModelType: snmp.AccessControlModelType.None,
	engineID: '8000B983800123456789ABCDEF01234567',
	address: null,
	transport: 'udp4',
} as const satisfies snmp.ReceiverOptions

export type TrapListenerOptions = {
	/** Only traps from here are passed on */
	host: string
	community: string
	/** The instance's createSharedUdpSocket, so several instances can listen on the trap port at once */
	createSocket: () => SharedUdpSocket
	onTrap: snmp.ReceiverCallback
	/** For a socket error once listening. One while binding rejects {@link TrapListener.start} instead */
	onError: (err: Error) => void
	log: (level: 'info' | 'error', message: string) => void
}

/** A trap receiver on a shared socket bound to the trap port */
export class TrapListener {
	readonly #options: TrapListenerOptions
	#socket: SharedUdpSocket | undefined
	#wrapper: SharedUDPSocketWrapper | undefined
	#receiver: snmp.ReceiverSession | undefined
	#closed = false

	get listening(): boolean {
		return this.#receiver !== undefined
	}

	constructor(options: TrapListenerOptions) {
		this.#options = options
	}

	/**
	 * Binds the socket and starts the receiver. Resolves without listening if closed while binding
	 * @throws if the socket fails to bind
	 */
	async start(): Promise<void> {
		const { host, community, createSocket, onTrap, onError, log } = this.#options
		const socket = createSocket()
		this.#socket = socket

		return new Promise<void>((resolve, reject) => {
			let bound = false
			socket.addListener('error', (err) => {
				// A socket closed while binding is no longer anyone's concern
				if (this.#closed) {
					resolve()
					return
				}
				log('error', `Listener error: ${err.message}`)
				if (bound) onError(err)
				else reject(err)
			})

			socket.bind(SNMP_TRAP_PORT, undefined, () => {
				bound = true
				// Closed while binding, when close could not close the socket
				if (this.#closed) {
					socket.removeAllListeners()
					socket.close()
					resolve()
					return
				}
				log('info', `Listening`)
				try {
					this.#wrapper = new SharedUDPSocketWrapper(
						socket,
						SNMP_TRAP_PORT,
						host,
						createModuleLogger('UDP Socket Wrapper'),
					)
					this.#receiver = snmp.createReceiver({ ...SnmpReceiverOptions, dgramModule: this.#wrapper }, onTrap)
					this.#receiver.getAuthorizer().addCommunity(community)
					log('info', `Bound to Port ${SNMP_TRAP_PORT} and waiting for Traps from ${host}`)
					resolve()
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)))
				}
			})
		})
	}

	close(): void {
		this.#closed = true
		this.#receiver?.close()
		this.#receiver = undefined
		this.#wrapper?.close()
		this.#wrapper?.removeAllListeners()
		this.#wrapper = undefined
		const socket = this.#socket
		this.#socket = undefined
		if (!socket) return
		try {
			socket.close()
		} catch {
			// close throws unless the socket is bound. One still binding is closed by its bind callback once it is, so its
			// listeners stay. One whose bind failed has nothing left to close
			return
		}
		socket.removeAllListeners()
	}
}
