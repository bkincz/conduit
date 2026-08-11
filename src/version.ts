import { version } from '../package.json'

/**
 * The conduit build this bundle carries. Recorded on the shared client so a
 * second bundle joining the page with a different copy can be reported instead
 * of silently disagreeing about cache or session shape.
 */
export const CONDUIT_VERSION: string = version
