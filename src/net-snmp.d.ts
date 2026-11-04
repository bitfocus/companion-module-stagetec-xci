import 'net-snmp'
import type { RemoteInfo } from 'dgram'

/**
 * Types for the trap receiver, which @types/net-snmp declares as `createReceiver(options: any, callback: any): any`.
 * Taken from companion-module-generic-snmp's src/net-snmp.d.ts, narrowed to what this module uses, and checked against
 * the Receiver, Listener and Authorizer in net-snmp 3.29's index.js.
 */
declare module 'net-snmp' {
	/** Anything with dgram's `createSocket`. The receiver binds and listens on what it returns */
	interface DgramModule {
		createSocket(type: 'udp4' | 'udp6'): unknown
	}

	interface ReceiverOptions {
		/** Defaults to 162 */
		port?: number
		/** When true the authorizer's communities and users are not checked, and every trap is passed on */
		disableAuthorization?: boolean
		/** When true the trap's community (v1/v2c) or user name (v3) is copied onto its pdu */
		includeAuthentication?: boolean
		accessControlModelType?: AccessControlModelType
		engineID?: string
		address?: string | null
		transport?: 'udp4' | 'udp6'
		dgramModule?: DgramModule
	}

	interface Authorizer {
		addCommunity(community: string): void
	}

	interface ReceiverSession {
		getAuthorizer(): Authorizer
		close(callback?: () => void): void
	}

	interface TrapPdu {
		id: number
		type: PduType
		varbinds: Varbind[]
		/** Only present with `includeAuthentication`, and only for v1/v2c */
		community?: string
		/** Only present with `includeAuthentication`, and only for v3 */
		user?: string
		/** v1 traps only */
		enterprise?: string
		/** v1 traps only */
		agentAddr?: string
		/** v1 traps only */
		generic?: TrapType
		/** v1 traps only. The trap's number, for an enterprise specific trap */
		specific?: number
		/** v1 traps only */
		upTime?: number
	}

	interface Notification {
		pdu: TrapPdu
		rinfo: RemoteInfo
	}

	type ReceiverCallback = (error: Error | null, notification?: Notification) => void

	function createReceiver(options: ReceiverOptions, callback: ReceiverCallback): ReceiverSession
}
