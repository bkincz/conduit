/*
 *   DEV FLAG
 ***************************************************************************************************/
export const DEV: boolean = (() => {
	try {
		return process.env.NODE_ENV !== 'production'
	} catch {
		return false
	}
})()
