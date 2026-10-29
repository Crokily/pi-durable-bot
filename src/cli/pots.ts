#!/usr/bin/env node
import { enableCompileCache } from "node:module";

// Most of the time a pots command takes to start is spent compiling code. Node keeps the compiled code on disk, in
// node-compile-cache in the temporary directory, for the next run; NODE_DISABLE_COMPILE_CACHE=1 turns it off. Only
// modules imported after this line use it, so the commands come in with import().
enableCompileCache();

// node:sqlite is stable in newer Node 24 releases. Older ones, such as 24.13, print an ExperimentalWarning about it in
// the middle of the first question of pots init; it says nothing a person can act on.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

await import("./commands.ts");
