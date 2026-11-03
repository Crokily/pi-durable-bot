import { readFileSync } from "node:fs";

/** This package's version, from package.json next to src/ or dist/. */
export const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
