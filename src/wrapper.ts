import { EventEmitter } from 'events'
import type { RemoteInfo } from 'dgram'
import type { ModuleLogger, SharedUdpSocket } from '@companion-module/base'
import type { DgramModule } from 'net-snmp'

/**
 * Wrapper for Companion's SharedUdpSocket that implements enough of the dgram.Socket interface for net-snmp's trap
 * receiver, which is handed it as its `dgramModule`. Only messages from `allowedAddress` are passed on.
 *
 * Taken from companion-module-generic-snmp's src/wrapper.ts.
 */
export class SharedUDPSocketWrapper extends EventEmitter implements DgramModule {
	readonly sharedSocket: SharedUdpSocket
	readonly port: number
	allowedAddress: string
	readonly isShared = true
	readonly #logger: ModuleLogger

	/**
	 * @param sharedSocket The Companion SharedUdpSocket, which this does not bind or close
	 * @param port The port the shared socket is bound to
	 * @param allowedAddress Only messages from this address are emitted
	 */
	constructor(sharedSocket: SharedUdpSocket, port: number, allowedAddress: string, logger: ModuleLogger) {
		super()
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Port out of range: ${port}`)
		this.sharedSocket = sharedSocket
		this.port = port
		this.allowedAddress = allowedAddress
		this.#logger = logger
		this.sharedSocket.on('message', this.messageHandler)
	}

	readonly messageHandler = (msg: Buffer, rinfo: RemoteInfo): void => {
		if (rinfo.address === this.allowedAddress) {
			this.emit('message', Buffer.from(msg), rinfo)
		} else {
			this.#logger.debug(`Message received from ${rinfo.address}:${rinfo.port}, ignoring`)
		}
	}

	/** Update the allowed IP address filter */
	setAllowedAddress(address: string): void {
		this.allowedAddress = address
	}

	/** No-op apart from the callback and event, as the shared socket is bound already */
	bind(_port?: number, _address?: string | null, callback?: () => void): void {
		if (callback) process.nextTick(callback)
		this.emit('listening')
	}

	address(): { address: string; family: string; port: number } {
		return { address: '0.0.0.0', family: 'IPv4', port: this.port }
	}

	get type(): 'udp4' {
		return 'udp4'
	}

	/** Stands in for dgram's createSocket, returning itself */
	createSocket(_type: 'udp4' | 'udp6'): this {
		return this
	}

	/** Stops passing messages on. The shared socket itself is left open */
	close(callback?: () => void): void {
		this.sharedSocket.removeListener('message', this.messageHandler)
		if (callback) process.nextTick(callback)
	}

	send(
		msg: Buffer | string | DataView,
		offset: number,
		length: number,
		port: number,
		address: string,
		callback?: () => void,
	): void {
		this.sharedSocket.send(msg, offset, length, port, address, callback)
	}

	ref(): this {
		return this
	}

	unref(): this {
		return this
	}
}
