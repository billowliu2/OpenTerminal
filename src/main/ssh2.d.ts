/**
 * Minimal ambient typings for the `ssh2` package (v1.17.0).
 *
 * ssh2 ships no type declarations and `@types/ssh2` is not installed; npm
 * install is out of scope here, so this file declares exactly the surface this
 * project consumes (verified against node_modules/ssh2/lib/client.js,
 * Channel.js, kex.js, agent.js, server.js). Lives under src/main/, which is
 * owned by this milestone.
 */

declare module 'ssh2' {
  import { Duplex } from 'stream'
  import { Socket } from 'net'

  /** Duplex wrapper around an SSH channel (shell/exec). */
  export interface ClientChannel extends Duplex {
    setWindow(rows: number, cols: number, height: number, width: number): void
    signal(signalName: string): void
    exit(statusOrSignal: number | string, coreDumped?: boolean, msg?: string): void
    close(): void
    stderr: import('stream').Readable
  }

  export interface PseudoTtyOptions {
    rows?: number
    cols?: number
    width?: number
    height?: number
    term?: string
  }

  export interface ShellOptions {
    rows?: number
    cols?: number
    width?: number
    height?: number
    term?: string
    /** environment (name => value) requested over the session */
    env?: Record<string, string>
    x11?: boolean | number | Record<string, unknown>
    /** forward a local ssh-agent to the remote session */
    agentForward?: boolean
  }

  export interface ConnectConfig {
    host?: string
    port?: number
    username: string
    password?: string
    privateKey?: Buffer | string
    passphrase?: string
    /** ssh-agent socket path or a BaseAgent instance */
    agent?: string
    /** forward the local agent to the remote (requires `agent`) */
    agentForward?: boolean
    /** keepalive interval in milliseconds (0 disables) */
    keepaliveInterval?: number
    keepaliveCountMax?: number
    /** ms to wait for handshake before erroring (0 disables) */
    readyTimeout?: number
    /** socket connect timeout in ms (0 disables) */
    timeout?: number
    hostHash?: string
    /**
     * Optional host key verification. When it returns a boolean, ssh2 uses it
     * synchronously; a promise-using implementer must instead call the `verify`
     * callback (returning `undefined`), which defers the handshake.
     */
    hostVerifier?: (key: Buffer, verify: (permitted: boolean) => void) => boolean | void
    debug?: (...args: unknown[]) => void
    algorithms?: Record<string, unknown>
    ident?: string | Buffer
    sock?: Socket
    strictVendor?: boolean
    localAddress?: string
    localHostname?: string
    localUsername?: string
    /** try keyboard-interactive auth */
    tryKeyboard?: boolean
    authHandler?: unknown
    forceIPv4?: boolean
    forceIPv6?: boolean
  }

  export class Client {
    connect(cfg: ConnectConfig): this
    end(): this
    destroy(): this
    shell(cb: (err: Error | undefined, stream: ClientChannel) => void): this
    shell(
      opts: PseudoTtyOptions | ShellOptions | false,
      cb: (err: Error | undefined, stream: ClientChannel) => void
    ): this
    exec(cmd: string, cb: (err: Error | undefined, stream: ClientChannel) => void): this
    /** request an SFTP channel (M4) */
    sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): this
    on(event: 'ready' | 'close' | 'continue', listener: () => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: string, listener: (...args: never[]) => void): this
  }

  /** POSIX attributes ssh2 attachments to readdir entries / returns from stat. */
  export interface SftpAttrs {
    mode: number
    uid: number
    gid: number
    size: number
    mtime: number
  }

  export interface SftpStats extends SftpAttrs {
    isDirectory(): boolean
  }

  /** Minimal SFTP surface used by src/main/sftp.ts (verified against SFTPWrapper). */
  export interface SFTPWrapper {
    end?(): void
    readdir(
      location: string,
      cb: (err: Error | null, names: Array<string | { filename: string; longname: string; attrs?: SftpAttrs }>) => void
    ): void
    mkdir(location: string, cb: (err: Error | null) => void): void
    rmdir(location: string, cb: (err: Error | null) => void): void
    unlink(location: string, cb: (err: Error | null) => void): void
    rename(src: string, dest: string, cb: (err: Error | null) => void): void
    setstat(location: string, attrs: { permissions?: number; uid?: number; gid?: number }, cb: (err: Error | null) => void): void
    stat(location: string, cb: (err: Error | null, stats: SftpStats) => void): void
    lstat(location: string, cb: (err: Error | null, stats: SftpStats) => void): void
    open(location: string, flags: string, cb: (err: Error | null, handle: Buffer) => void): void
    close(handle: Buffer, cb: (err: Error | null) => void): void
    fstat(handle: Buffer, cb: (err: Error | null, stats: SftpStats) => void): void
    write(handle: Buffer, buf: Buffer, offset: number, length: number, position: number, cb: (err: Error | null) => void): void
    read(handle: Buffer, buf: Buffer, offset: number, length: number, position: number, cb: (err: Error | null, res: { bytesRead: number; buffer: Buffer }) => void): void
  }

  export function createAgent(path: string): unknown
}