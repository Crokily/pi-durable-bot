#!/usr/bin/env node
import { enableCompileCache } from "node:module";

// Most of the time a pots command takes to start is spent compiling code. Node keeps the compiled code on disk, in
// node-compile-cache in the temporary directory, for the next run; NODE_DISABLE_COMPILE_CACHE=1 turns it off. Only
// modules imported after this line use it, so the commands come in with import().
enableCompileCache();
await import("./commands.ts");
