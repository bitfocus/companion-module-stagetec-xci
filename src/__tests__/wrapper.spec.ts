import { EventEmitter } from 'node:events'
import type { RemoteInfo } from 'node:dgram'
import { describe, expect, it, vi } from 'vitest'
import type { ModuleLogger, SharedUdpSocket } from '@companion-module/base'
import { SharedUDPSocketWrapper } from '../wrapper.js'

const XCI = '192.0.2.10'

function setup() {
	const shared = Object.assign(new EventEmitter(), { send: vi.fn() })
	const logger: ModuleLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	const wrapper = new SharedUDPSocketWrapper(shared as unknown as SharedUdpSocket, 162, XCI, logger)
	const received = vi.fn<(msg: Buffer, rinfo: RemoteInfo) => void>()
	wrapper.on('message', received)
	const deliver = (address: string) =>
		shared.emit('message', Buffer.from('trap'), { address, family: 'IPv4', port: 5000, size: 4 })
	return { shared, wrapper, received, deliver }
}

describe('SharedUDPSocketWrapper', () => {
	it('passes on messages from the allowed address only', () => {
		const { received, deliver } = setup()
		deliver('192.0.2.99')
		deliver(XCI)
		expect(received).toHaveBeenCalledOnce()
		expect(received.mock.calls[0][1].address).toBe(XCI)
	})

	it('follows a change of allowed address', () => {
		const { wrapper, received, deliver } = setup()
		wrapper.setAllowedAddress('192.0.2.99')
		deliver(XCI)
		deliver('192.0.2.99')
		expect(received).toHaveBeenCalledOnce()
		expect(received.mock.calls[0][1].address).toBe('192.0.2.99')
	})

	it('stops passing messages on once closed, leaving the shared socket to its owner', async () => {
		const { wrapper, received, deliver, shared } = setup()
		const closed = new Promise<void>((resolve) => wrapper.close(resolve))
		deliver(XCI)
		await closed
		expect(received).not.toHaveBeenCalled()
		expect(shared.listenerCount('message')).toBe(0)
	})

	it('acts as its own dgram module, and reports listening when bound', async () => {
		const { wrapper } = setup()
		expect(wrapper.createSocket('udp4')).toBe(wrapper)
		const listening = vi.fn()
		wrapper.on('listening', listening)
		await new Promise<void>((resolve) => wrapper.bind(162, null, resolve))
		expect(listening).toHaveBeenCalledOnce()
		expect(wrapper.address()).toEqual({ address: '0.0.0.0', family: 'IPv4', port: 162 })
	})

	it('sends through the shared socket', () => {
		const { wrapper, shared } = setup()
		const msg = Buffer.from('reply')
		wrapper.send(msg, 0, msg.length, 5000, XCI)
		expect(shared.send).toHaveBeenCalledWith(msg, 0, msg.length, 5000, XCI, undefined)
	})

	it.each([0, 65536, 1.5])('rejects port %s', (port) => {
		const shared = new EventEmitter() as unknown as SharedUdpSocket
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
		expect(() => new SharedUDPSocketWrapper(shared, port, XCI, logger)).toThrow(/Port out of range/)
	})
})
