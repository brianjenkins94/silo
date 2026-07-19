/** The silo extension bundled to a browser CommonJS string (see the plugin in entry.config.ts). */
declare module "silo:extension" {
	const code: string;
	export default code;
}

/** A git snapshot of the silo repo, baked in at build time (see snapshot.ts). */
declare module "silo:workspace" {
	const files: { "path": string; "contents": string }[];
	export default files;
}

/** `silo review --json` output (the review-units artifact), baked in at build time (see snapshot.ts). */
declare module "silo:review" {
	const json: string;
	export default json;
}
