// Next.js ships no `exports` map, so an ES module's `import 'next/server'` doesn't resolve its types under NodeNext. The
// imports stay as Next.js documents them (its compiler aliases them); these point TypeScript at the files.
declare module 'next/server' {
	export * from 'next/server.js'
}
declare module 'next/navigation' {
	export * from 'next/navigation.js'
}
declare module 'next/link' {
	// A bundler hands the component as the default export (`__esModule`), as Next.js's own types say.
	const Link: (typeof import('next/dist/client/link.js'))['default']
	export default Link
}
