/**
 * The short key of a message, for compiled catalogs (`keys: 'hashed'`): a 53-bit hash of its key, written in base 36 —
 * about 10 characters instead of the whole text. 53 bits keep collisions out of reach for any real catalog (the CLI
 * checks anyway), and the hash is cheap enough to compute once per message per locale.
 *
 * cyrb53, by bryc: public domain.
 */
export const hashKey = (key: string): string => {
	let h1 = 0xdeadbeef
	let h2 = 0x41c6ce57
	for (let index = 0; index < key.length; index++) {
		const code = key.charCodeAt(index)
		h1 = Math.imul(h1 ^ code, 2654435761)
		h2 = Math.imul(h2 ^ code, 1597334677)
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
