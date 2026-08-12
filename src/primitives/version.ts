import { version } from '../../package.json'

/** The conduit build this bundle carries, so a shared client can report a version skew. */
export const CONDUIT_VERSION: string = version
